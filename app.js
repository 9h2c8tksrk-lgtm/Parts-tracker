const maximumBarcodeLength = 14;

let supabaseClient;
let currentUser;
let parts = [];
let assignments = [];
let selectedPart;
let html5QrCode;
let scannerStarting = false;
let realtimeChannel;
let lookupRequest = 0;
let offlineDatabase;
const assignmentColumns = 'id, created_at, wo_number, asset_number, barcode, part_name, description, quantity, created_by, assigned_by';

const byId = id => document.getElementById(id);

function openOfflineDatabase() {
	if (!('indexedDB' in window)) return Promise.reject(new Error('Offline storage is not supported by this browser.'));
	if (offlineDatabase) return offlineDatabase;
	offlineDatabase = new Promise((resolve, reject) => {
		const request = indexedDB.open('parts-tracker-offline', 1);
		request.onupgradeneeded = () => {
			const database = request.result;
			database.createObjectStore('snapshots', { keyPath: 'userId' });
			database.createObjectStore('pending_assignments', { keyPath: 'id' });
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	return offlineDatabase;
}

async function offlineStore(storeName, mode, action) {
	const database = await openOfflineDatabase();
	return new Promise((resolve, reject) => {
		const transaction = database.transaction(storeName, mode);
		const request = action(transaction.objectStore(storeName));
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function saveOfflineSnapshot(userId) {
	return offlineStore('snapshots', 'readwrite', store => store.put({
		userId,
		parts,
		assignments,
		savedAt: new Date().toISOString()
	}));
}

async function loadOfflineSnapshot(userId) {
	const snapshot = await offlineStore('snapshots', 'readonly', store => store.get(userId));
	parts = snapshot?.parts ?? [];
	assignments = snapshot?.assignments ?? [];
	const pending = await offlineStore('pending_assignments', 'readonly', store => store.getAll());
	const userPending = pending.filter(assignment => assignment.created_by === userId);
	userPending.forEach(assignment => {
		if (!assignments.some(saved => saved.id === assignment.id)) assignments.push(assignment);
	});
	assignments.sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
	renderAssignments();
	return Boolean(snapshot || userPending.length);
}

async function queueOfflineAssignment(assignment) {
	assignment.pending_offline = true;
	await offlineStore('pending_assignments', 'readwrite', store => store.put(assignment));
	assignments.unshift(assignment);
	await saveOfflineSnapshot(currentUser.id);
	renderAssignments();
	setStatus('Assignment saved on this device. It will sync when you are back online.');
}

async function syncPendingAssignments() {
	if (!currentUser || !navigator.onLine) return;
	const pending = await offlineStore('pending_assignments', 'readonly', store => store.getAll());
	for (const assignment of pending.filter(item => item.created_by === currentUser.id)) {
		const { error } = await supabaseClient.from('assigned_parts').insert({
			id: assignment.id,
			created_at: assignment.created_at,
			wo_number: assignment.wo_number,
			asset_number: assignment.asset_number,
			barcode: assignment.barcode,
			part_name: assignment.part_name,
			description: assignment.description,
			quantity: assignment.quantity,
			created_by: assignment.created_by,
			assigned_by: assignment.assigned_by
		});
		if (error && error.code !== '23505') throw error;
		await offlineStore('pending_assignments', 'readwrite', store => store.delete(assignment.id));
		assignments = assignments.map(item => item.id === assignment.id
			? { ...item, pending_offline: false }
			: item);
	}
}

function isNetworkFailure(error) {
	return error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(error?.message ?? '');
}

function setStatus(message, isError = false, target = 'app-status') {
	const status = byId(target);
	status.textContent = message;
	status.classList.toggle('hidden', !message);
	status.classList.toggle('text-red-700', isError);
	status.classList.toggle('bg-red-100', isError);
	status.classList.toggle('border-red-300', isError);
	status.classList.toggle('bg-blue-100', !isError);
	status.classList.toggle('border-blue-300', !isError);
}

function appendCell(row, value) {
	const cell = document.createElement('td');
	cell.className = 'border px-2 py-1';
	cell.textContent = value == null ? '' : String(value);
	row.appendChild(cell);
}

function renderAssignments() {
	const tbody = byId('logs-table-body');
	tbody.replaceChildren();

	assignments.forEach(assignment => {
		const row = document.createElement('tr');
		appendCell(row, new Date(assignment.created_at).toLocaleString());
		appendCell(row, assignment.wo_number);
		appendCell(row, assignment.asset_number);
		appendCell(row, assignment.pending_offline ? 'Pending sync' : 'Synced');
		appendCell(row, assignment.barcode);
		appendCell(row, assignment.part_name);
		appendCell(row, assignment.description);
		appendCell(row, assignment.quantity ?? 1);
		appendCell(row, assignment.assigned_by || assignment.created_by);
		tbody.appendChild(row);
	});
}

function renderPart(part) {
	selectedPart = part;
	byId('part-name').textContent = part?.part_name ?? '';
	byId('part-desc').textContent = part?.description ?? '';
	byId('new-part-form').classList.toggle('hidden', Boolean(part));
}

function findPartByBarcode(barcode) {
	return parts.find(part => part.barcode === barcode);
}

async function fetchAllParts() {
	const pageSize = 1000;
	const all = [];
	for (let from = 0; ; from += pageSize) {
		const { data, error } = await supabaseClient.from('parts')
			.select('barcode, part_name, description')
			.order('barcode')
			.range(from, from + pageSize - 1);
		if (error) return { data: null, error };
		all.push(...data);
		if (data.length < pageSize) return { data: all.sort((a, b) => a.part_name.localeCompare(b.part_name)), error: null };
	}
}

async function loadSharedData() {
	if (!navigator.onLine) {
		const hasSnapshot = await loadOfflineSnapshot(currentUser.id).catch(() => false);
		setStatus(hasSnapshot
			? 'Offline mode: showing saved data. New assignments will sync when connected.'
			: 'Offline mode: no saved data yet. Connect and sign in to download the parts list.', !hasSnapshot);
		return;
	}

	setStatus('Loading shared parts and assignments...');
	try {
		await loadOfflineSnapshot(currentUser.id).catch(() => false);
		let syncError;
		try {
			await syncPendingAssignments();
		} catch (error) {
			syncError = error;
		}
		await saveOfflineSnapshot(currentUser.id).catch(() => {});
		const [partsResult, assignmentsResult] = await Promise.all([
			fetchAllParts(),
			supabaseClient.from('assigned_parts')
				.select(assignmentColumns)
				.order('created_at', { ascending: false })
				.limit(1000)
		]);

		if (partsResult.error) throw partsResult.error;

		parts = partsResult.data;
		byId('parts-count').textContent = `Parts available to look up: ${parts.length}`;
		if (assignmentsResult.error) {
			syncError ??= assignmentsResult.error;
		} else {
			assignments = assignmentsResult.data;
		}
		renderAssignments();
		await saveOfflineSnapshot(currentUser.id).catch(() => {});
		setStatus(syncError
			? `Parts loaded, but the assignment log or queued assignments failed: ${syncError.message}. If this mentions "quantity", run the quantity SQL in Supabase.`
			: '');
	} catch (error) {
		const hasSnapshot = await loadOfflineSnapshot(currentUser.id).catch(() => false);
		setStatus(hasSnapshot
			? 'Could not reach the server. Showing saved data; pending assignments will sync when connected.'
			: `Could not load shared data: ${error.message}`, !hasSnapshot);
	}
}

function displayAuth(session) {
	currentUser = session?.user ?? null;
	byId('auth-panel').classList.toggle('hidden', Boolean(currentUser));
	byId('app-panel').classList.toggle('hidden', !currentUser);
	byId('current-user').textContent = currentUser?.email ?? '';

	if (!currentUser) {
		lookupRequest += 1;
		if (realtimeChannel) {
			supabaseClient.removeChannel(realtimeChannel);
			realtimeChannel = undefined;
		}
		parts = [];
		byId('parts-count').textContent = '';
		assignments = [];
		renderPart(null);
		byId('logs-table-body').replaceChildren();
		byId('barcode-value').textContent = '';
		byId('barcode-input').value = '';
		endPick();
		byId('new-part-form').classList.add('hidden');
		if (html5QrCode?.isScanning) {
			html5QrCode.stop().catch(error => setStatus(`Could not stop the camera: ${error.message}`, true));
		}
		return;
	}

	loadSharedData().catch(error => setStatus(`Could not load shared data: ${error.message}`, true));
	subscribeToSharedChanges();
	startScanner();
}

function updateConnectionStatus() {
	const status = byId('connection-status');
	status.textContent = navigator.onLine
		? 'Online: data syncs with the shared server. Cached data is available for offline use.'
		: 'Offline: using saved data. Assignments are queued on this device until connection returns.';
	status.classList.toggle('bg-yellow-100', !navigator.onLine);
	status.classList.toggle('border-yellow-400', !navigator.onLine);
	status.classList.toggle('bg-green-100', navigator.onLine);
	status.classList.toggle('border-green-400', navigator.onLine);
}

function subscribeToSharedChanges() {
	if (realtimeChannel) {
		supabaseClient.removeChannel(realtimeChannel);
	}
	realtimeChannel = supabaseClient
		.channel('shared-parts-and-assignments')
		.on('postgres_changes', { event: '*', schema: 'public', table: 'parts' }, () => {
			loadSharedData().catch(error => setStatus(`Could not refresh shared parts: ${error.message}`, true));
		})
		.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'assigned_parts' }, () => {
			loadSharedData().catch(error => setStatus(`Could not refresh shared assignments: ${error.message}`, true));
		})
		.subscribe(status => {
			if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
				setStatus('Live updates could not connect. Shared data will still save; reload to see other users’ latest changes.', true);
			}
		});
}

function csvCell(value) {
	let text = value == null ? '' : String(value);
	if (/^[\t\r ]*[=+\-@]/.test(text)) {
		text = `'${text}`;
	}
	return `"${text.replace(/"/g, '""')}"`;
}

function exportAssignmentsToCSV() {
	if (!assignments.length) {
		setStatus('There are no assignments to export.');
		return;
	}
	const headers = ['Timestamp', 'WO Number', 'Asset Number', 'Barcode', 'Part Name', 'Description', 'Quantity', 'Assigned By'];
	const rows = assignments.map(assignment => [
		assignment.created_at,
		assignment.wo_number,
		assignment.asset_number,
		assignment.barcode,
		assignment.part_name,
		assignment.description,
		assignment.quantity ?? 1,
		assignment.assigned_by || assignment.created_by
	]);
	const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
	const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = 'assigned_parts_log.csv';
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

function showUnknownBarcode(message) {
	renderPart(null);
	byId('new-part-name').value = '';
	byId('new-part-desc').value = '';
	setStatus(message);
}

async function selectBarcode(rawBarcode, forceLookup = false) {
	const barcode = rawBarcode.trim();
	if (!barcode || barcode.length > maximumBarcodeLength) {
		lookupRequest += 1;
		byId('barcode-value').textContent = '';
		byId('part-name').textContent = '';
		byId('part-desc').textContent = '';
		byId('new-part-form').classList.add('hidden');
		setStatus(`Enter a barcode of 1 to ${maximumBarcodeLength} characters.`, true);
		return;
	}
	if (!forceLookup && !activePick && barcode === byId('barcode-value').textContent) return;

	lookupRequest += 1;
	byId('barcode-value').textContent = barcode;
	byId('barcode-input').value = barcode;
	const existingPart = findPartByBarcode(barcode);
	if (existingPart) {
		renderPart(existingPart);
		if (activePick) {
			addToPick(existingPart, !forceLookup);
			return;
		}
		setStatus(`Found: ${existingPart.part_name} — ${existingPart.description || 'no description'}. Start a pick to assign parts to a work order.`);
		return;
	}

	byId('part-name').textContent = '';
	byId('part-desc').textContent = '';
	byId('new-part-form').classList.add('hidden');

	showUnknownBarcode('Not found in your parts list. Enter the part details to add it.');
}

async function addPart(event) {
	event.preventDefault();
	if (!currentUser || !byId('barcode-value').textContent) return;
	if (!navigator.onLine) {
		setStatus('Adding a new part requires an internet connection.', true);
		return;
	}

	const barcode = byId('barcode-value').textContent;
	const part = {
		barcode,
		part_name: byId('new-part-name').value.trim(),
		description: byId('new-part-desc').value.trim()
	};
	if (!part.part_name) {
		setStatus('Enter a part name.', true);
		return;
	}

	const { data, error } = await supabaseClient.from('parts').insert(part)
		.select('barcode, part_name, description')
		.single();
	if (error) {
		setStatus(!navigator.onLine
			? 'Adding a new part requires an internet connection.'
			: error.code === '23505'
			? 'Another user has already added this barcode. Refresh the shared list and look it up again.'
			: `Could not add the part: ${error.message}`, true);
		return;
	}

	if (!findPartByBarcode(data.barcode)) parts.push(data);
	renderPart(data);
	await saveOfflineSnapshot(currentUser.id).catch(() => {});
	setStatus('Part added to the shared parts list.');
	addToPick(data, false);
}

let activePick = null;
let lastPickScan = { barcode: '', time: 0 };
const duplicateScanWindowMs = 2000;

function renderPick() {
	byId('pick-form').classList.toggle('hidden', Boolean(activePick));
	byId('pick-active').classList.toggle('hidden', !activePick);
	byId('active-wo').textContent = activePick?.woNumber ?? '';
	byId('active-asset').textContent = activePick?.assetNumber ?? '';
	byId('active-asset-wrap').classList.toggle('hidden', !activePick?.assetNumber);

	const tbody = byId('pick-items-body');
	tbody.replaceChildren();
	const items = activePick ? [...activePick.items.values()] : [];
	byId('pick-empty').classList.toggle('hidden', items.length > 0);
	items.forEach(item => {
		const row = document.createElement('tr');
		appendCell(row, item.part.barcode);
		appendCell(row, item.part.part_name);

		const qtyCell = document.createElement('td');
		qtyCell.className = 'border px-2 py-1';
		const input = document.createElement('input');
		input.type = 'number';
		input.min = '1';
		input.step = '1';
		input.value = String(item.qty);
		input.className = 'w-20 border rounded px-2 py-1';
		input.setAttribute('aria-label', `Quantity for ${item.part.part_name}`);
		input.addEventListener('change', () => {
			const qty = Math.floor(Number(input.value));
			item.qty = Number.isFinite(qty) && qty >= 1 ? qty : item.qty;
			input.value = String(item.qty);
		});
		qtyCell.appendChild(input);
		row.appendChild(qtyCell);

		const removeCell = document.createElement('td');
		removeCell.className = 'border px-2 py-1';
		const removeBtn = document.createElement('button');
		removeBtn.type = 'button';
		removeBtn.textContent = 'Remove';
		removeBtn.className = 'text-red-700 underline';
		removeBtn.addEventListener('click', () => {
			activePick.items.delete(item.part.barcode);
			renderPick();
		});
		removeCell.appendChild(removeBtn);
		row.appendChild(removeCell);
		tbody.appendChild(row);
	});
}

function startPick(event) {
	event.preventDefault();
	const woNumber = byId('wo-input').value.trim();
	if (!woNumber) {
		setStatus('Enter a work order number to start a pick.', true);
		return;
	}
	activePick = { woNumber, assetNumber: byId('asset-number-input').value.trim(), items: new Map() };
	lastPickScan = { barcode: '', time: 0 };
	renderPick();
	setStatus('Pick started. Each scan adds one to that part’s quantity; adjust quantities before completing.');
}

function endPick() {
	activePick = null;
	byId('wo-input').value = '';
	byId('asset-number-input').value = '';
	renderPick();
}

function addToPick(part, isCameraScan) {
	if (!activePick) return;
	const now = Date.now();
	// The camera decodes the same code many times a second; treat a quick repeat as one scan
	if (isCameraScan && lastPickScan.barcode === part.barcode && now - lastPickScan.time < duplicateScanWindowMs) {
		lastPickScan.time = now;
		return;
	}
	lastPickScan = { barcode: part.barcode, time: now };
	const item = activePick.items.get(part.barcode);
	if (item) item.qty += 1;
	else activePick.items.set(part.barcode, { part, qty: 1 });
	renderPick();
	setStatus(`Found: ${part.part_name} — ${part.description || 'no description'}. Quantity ${activePick.items.get(part.barcode).qty}.`);
}

async function saveAssignment(newAssignment) {
	if (!navigator.onLine) {
		await queueOfflineAssignment(newAssignment);
		return true;
	}
	let result;
	try {
		result = await supabaseClient.from('assigned_parts').insert(newAssignment)
			.select(assignmentColumns)
			.single();
	} catch (error) {
		if (error instanceof TypeError || !navigator.onLine) {
			await queueOfflineAssignment(newAssignment);
			return true;
		}
		throw error;
	}
	const { data, error } = result;
	if (error) {
		if (!navigator.onLine || isNetworkFailure(error)) {
			await queueOfflineAssignment(newAssignment);
			return true;
		}
		setStatus(`Could not save the assignment: ${error.message}`, true);
		return false;
	}
	if (!assignments.some(assignment => assignment.id === data.id)) assignments.push(data);
	return true;
}

async function completePick() {
	if (!currentUser || !activePick) return;
	const { woNumber, assetNumber, items } = activePick;
	if (!items.size) {
		endPick();
		setStatus('Pick ended with no parts assigned.');
		return;
	}
	byId('pick-complete-btn').disabled = true;
	try {
		const createdAt = new Date().toISOString();
		for (const item of [...items.values()]) {
			const saved = await saveAssignment({
				id: crypto.randomUUID(),
				created_at: createdAt,
				wo_number: woNumber,
				asset_number: assetNumber,
				barcode: item.part.barcode,
				part_name: item.part.part_name,
				description: item.part.description,
				quantity: item.qty,
				created_by: currentUser.id,
				assigned_by: currentUser.email
			});
			if (!saved) {
				renderPick();
				return;
			}
			items.delete(item.part.barcode);
		}
		assignments.sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
		assignments = assignments.slice(0, 1000);
		renderAssignments();
		await saveOfflineSnapshot(currentUser.id).catch(() => {});
		endPick();
		setStatus(`Pick completed for WO ${woNumber}. Assignments saved.`);
	} finally {
		byId('pick-complete-btn').disabled = false;
	}
}

async function authenticate(mode) {
	if (!byId('auth-form').reportValidity()) return;
	const email = byId('email-input').value.trim();
	const password = byId('password-input').value;
	setStatus('Signing in...', false, 'auth-status');
	const result = mode === 'signup'
		? await supabaseClient.auth.signUp({ email, password })
		: await supabaseClient.auth.signInWithPassword({ email, password });

	if (result.error) {
		setStatus(result.error.message, true, 'auth-status');
		return;
	}
	if (mode === 'signup' && !result.data.session) {
		setStatus('Account created. Check your email to confirm it, then sign in.', false, 'auth-status');
		return;
	}
	setStatus('Authentication successful.', false, 'auth-status');
}

async function enableTorch() {
	const btn = byId('torch-btn');
	try {
		const torch = html5QrCode.getRunningTrackCameraCapabilities().torchFeature();
		if (!torch.isSupported()) throw new Error('unsupported');
		await torch.apply(true);
		btn.textContent = 'Flash: on';
		btn.dataset.on = '1';
		btn.onclick = async () => {
			const turnOn = btn.dataset.on !== '1';
			await torch.apply(turnOn).catch(() => {});
			btn.dataset.on = turnOn ? '1' : '';
			btn.textContent = turnOn ? 'Flash: on' : 'Flash: off';
		};
		btn.classList.remove('hidden');
	} catch {
		btn.classList.add('hidden');
		setStatus('Camera flash is not available on this device or browser. You can still scan.');
	}
}

async function startScanner() {
	if (!currentUser || scannerStarting || typeof Html5Qrcode === 'undefined' || html5QrCode?.isScanning) return;
	scannerStarting = true;
	try {
		const formats = Html5QrcodeSupportedFormats;
		html5QrCode ??= new Html5Qrcode('qr-reader', {
			useBarCodeDetectorIfSupported: true,
			verbose: false,
			formatsToSupport: [
				formats.EAN_13, formats.EAN_8, formats.UPC_A, formats.UPC_E, formats.UPC_EAN_EXTENSION,
				formats.CODE_128, formats.CODE_39, formats.CODE_93, formats.ITF, formats.CODABAR,
				formats.QR_CODE, formats.DATA_MATRIX
			]
		});
		const cameras = await Html5Qrcode.getCameras();
		if (!currentUser) return;
		if (!cameras?.length) {
			setStatus('No camera was found. You can enter a barcode manually.');
			return;
		}
		await html5QrCode.start(
			{ facingMode: 'environment' },
			{
				fps: 30,
				// html5-qrcode only accepts a single key in the first argument; extra constraints go here
				videoConstraints: {
					facingMode: 'environment',
					width: { ideal: 1920 },
					height: { ideal: 1080 },
					advanced: [{ focusMode: 'continuous' }]
				},
				// Wide box suits 1D barcodes and scales with the viewfinder
				qrbox: (width, height) => ({ width: Math.floor(width * 0.9), height: Math.floor(Math.min(height, width) * 0.5) }),
				disableFlip: true
			},
			decodedText => selectBarcode(decodedText),
			() => {}
		);
		await enableTorch();
	} catch (error) {
		setStatus(`Camera unavailable: ${error?.message || error || 'permission denied or no camera found'}. You can enter a barcode manually.`);
	} finally {
		scannerStarting = false;
	}
}

document.addEventListener('DOMContentLoaded', async () => {
	updateConnectionStatus();
	window.addEventListener('online', () => {
		updateConnectionStatus();
		if (currentUser) loadSharedData().catch(error => setStatus(`Could not sync offline data: ${error.message}`, true));
	});
	window.addEventListener('offline', () => {
		updateConnectionStatus();
		if (currentUser) loadSharedData().catch(error => setStatus(`Could not load saved data: ${error.message}`, true));
	});
	if ('serviceWorker' in navigator && location.protocol !== 'file:') {
		navigator.serviceWorker.register('./service-worker.js')
			.catch(() => setStatus('Offline app caching could not be enabled. Use a secure HTTPS or localhost address.', true));
	}

	const config = window.SUPABASE_CONFIG;
	if (!window.supabase?.createClient || !config?.url || !config?.anonKey) {
		byId('setup-message').textContent = 'Supabase is not configured. Add your project URL and publishable/anon key to config.js, then reload this page. See README.md for setup instructions.';
		byId('setup-message').classList.remove('hidden');
		return;
	}

	supabaseClient = window.supabase.createClient(config.url, config.anonKey);
	byId('auth-panel').classList.remove('hidden');

	byId('auth-form').addEventListener('submit', event => {
		event.preventDefault();
		authenticate('signin').catch(error => setStatus(error.message, true, 'auth-status'));
	});
	byId('signup-btn').addEventListener('click', () => {
		authenticate('signup').catch(error => setStatus(error.message, true, 'auth-status'));
	});
	byId('signout-btn').addEventListener('click', async () => {
		const { error } = await supabaseClient.auth.signOut();
		if (error) setStatus(`Could not sign out: ${error.message}`, true);
	});
	byId('barcode-form').addEventListener('submit', event => {
		event.preventDefault();
		selectBarcode(byId('barcode-input').value, true).catch(error => setStatus(error.message, true));
	});
	byId('new-part-form').addEventListener('submit', event => {
		addPart(event).catch(error => setStatus(error.message, true));
	});
	byId('pick-form').addEventListener('submit', startPick);
	byId('pick-complete-btn').addEventListener('click', () => {
		completePick().catch(error => setStatus(error.message, true));
	});
	byId('export-btn').addEventListener('click', exportAssignmentsToCSV);

	supabaseClient.auth.onAuthStateChange((_event, session) => {
		setTimeout(() => displayAuth(session), 0);
	});
	const { data, error } = await supabaseClient.auth.getSession();
	if (error) {
		setStatus(`Could not check the current sign-in: ${error.message}`, true, 'auth-status');
		return;
	}
	displayAuth(data.session);
});
