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
let stockCounts = [];
let aliases = [];
const countColumns = 'id, created_at, count_name, barcode, part_name, description, counted_qty, created_by, counted_by';
const assignmentColumns = 'id, created_at, wo_number, asset_number, barcode, part_name, description, quantity, created_by, assigned_by';

const byId = id => document.getElementById(id);

function openOfflineDatabase() {
	if (!('indexedDB' in window)) return Promise.reject(new Error('Offline storage is not supported by this browser.'));
	if (offlineDatabase) return offlineDatabase;
	offlineDatabase = new Promise((resolve, reject) => {
		const request = indexedDB.open('parts-tracker-offline', 3);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains('snapshots')) database.createObjectStore('snapshots', { keyPath: 'userId' });
			if (!database.objectStoreNames.contains('pending_assignments')) database.createObjectStore('pending_assignments', { keyPath: 'id' });
			if (!database.objectStoreNames.contains('pending_counts')) database.createObjectStore('pending_counts', { keyPath: 'id' });
			if (!database.objectStoreNames.contains('pending_parts')) database.createObjectStore('pending_parts', { keyPath: 'barcode' });
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
		aliases,
		assignments,
		savedAt: new Date().toISOString()
	}));
}

async function loadOfflineSnapshot(userId) {
	const snapshot = await offlineStore('snapshots', 'readonly', store => store.get(userId));
	parts = snapshot?.parts ?? [];
	aliases = snapshot?.aliases ?? [];
	assignments = snapshot?.assignments ?? [];
	const pending = await offlineStore('pending_assignments', 'readonly', store => store.getAll());
	const userPending = pending.filter(assignment => assignment.created_by === userId);
	userPending.forEach(assignment => {
		if (!assignments.some(saved => saved.id === assignment.id)) assignments.push(assignment);
	});
	assignments.sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
	await mergePendingParts(userId);
	renderAssignments();
	return Boolean(snapshot || userPending.length);
}

async function mergePendingParts(userId) {
	const pending = await offlineStore('pending_parts', 'readonly', store => store.getAll()).catch(() => []);
	pending.filter(part => part.created_by === userId).forEach(part => {
		if (!findPartByBarcode(part.barcode)) {
			parts.push({ barcode: part.barcode, part_name: part.part_name, description: part.description, pending_offline: true });
		}
	});
}

async function queueOfflinePart(part) {
	await offlineStore('pending_parts', 'readwrite', store => store.put({ ...part, created_by: currentUser.id }));
	const queued = { ...part, pending_offline: true };
	parts.push(queued);
	await saveOfflineSnapshot(currentUser.id).catch(() => {});
	return queued;
}

async function syncPendingParts() {
	if (!currentUser || !navigator.onLine) return;
	const pending = await offlineStore('pending_parts', 'readonly', store => store.getAll());
	for (const part of pending.filter(item => item.created_by === currentUser.id)) {
		const { error } = await supabaseClient.from('parts').insert({
			barcode: part.barcode,
			part_name: part.part_name,
			description: part.description
		});
		if (error && error.code !== '23505') throw error;
		await offlineStore('pending_parts', 'readwrite', store => store.delete(part.barcode));
	}
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

let photoRequest = 0;

async function showPartPhoto(part) {
	photoRequest += 1;
	const requestId = photoRequest;
	const img = byId('part-photo');
	img.classList.add('hidden');
	img.removeAttribute('src');
	byId('photo-controls').classList.toggle('hidden', !part || part.pending_offline);
	if (!part?.photo_path || !navigator.onLine) return;
	const { data } = await supabaseClient.storage.from('part-photos').createSignedUrl(part.photo_path, 3600).catch(() => ({}));
	if (requestId !== photoRequest || !data?.signedUrl) return;
	img.src = data.signedUrl;
	img.classList.remove('hidden');
}

function resizeImage(file, maxSize = 1280) {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const image = new Image();
		image.onload = () => {
			const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
			const canvas = document.createElement('canvas');
			canvas.width = Math.round(image.width * scale);
			canvas.height = Math.round(image.height * scale);
			canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
			URL.revokeObjectURL(url);
			canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not process the photo.')), 'image/jpeg', 0.8);
		};
		image.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error('Could not read the photo.'));
		};
		image.src = url;
	});
}

async function savePartPhoto(file) {
	const part = selectedPart;
	if (!currentUser || !part || !file) return;
	if (!navigator.onLine) {
		setStatus('Saving a photo requires an internet connection.', true);
		return;
	}
	setStatus('Uploading photo...');
	const blob = await resizeImage(file);
	const path = `${crypto.randomUUID()}.jpg`;
	const upload = await supabaseClient.storage.from('part-photos').upload(path, blob, { contentType: 'image/jpeg' });
	if (upload.error) {
		setStatus(`Could not upload the photo: ${upload.error.message}. Make sure the photo SQL has been run in Supabase.`, true);
		return;
	}
	const { error } = await supabaseClient.from('parts').update({ photo_path: path }).eq('barcode', part.barcode);
	if (error) {
		setStatus(`Could not save the photo: ${error.message}`, true);
		return;
	}
	part.photo_path = path;
	await saveOfflineSnapshot(currentUser.id).catch(() => {});
	setStatus('Photo saved.');
	if (selectedPart === part) showPartPhoto(part);
}

function renderPart(part) {
	selectedPart = part;
	showPartPhoto(part);
	byId('part-name').textContent = part?.part_name ?? '';
	byId('part-desc').textContent = part?.description ?? '';
	setNewPartUi(!part);
}

function setNewPartUi(show) {
	byId('new-part-form').classList.toggle('hidden', !show);
	byId('link-section').classList.toggle('hidden', !show);
	if (!show) {
		byId('link-search-input').value = '';
		byId('link-results').replaceChildren();
	}
}

function searchParts(event) {
	event?.preventDefault();
	const terms = byId('part-search-input').value.toLowerCase().split(/\s+/).filter(Boolean);
	const list = byId('part-search-results');
	list.replaceChildren();
	if (!terms.length) return;
	const matches = parts.filter(part => {
		const text = `${part.part_name} ${part.description} ${part.barcode}`.toLowerCase();
		return terms.every(term => text.includes(term));
	});
	if (!matches.length) {
		const item = document.createElement('li');
		item.className = 'text-sm text-gray-600';
		item.textContent = 'No matching parts.';
		list.appendChild(item);
		return;
	}
	matches.slice(0, 20).forEach(part => {
		const item = document.createElement('li');
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'w-full text-left border rounded px-2 py-2 hover:bg-gray-100';
		const name = document.createElement('span');
		name.className = 'font-semibold';
		name.textContent = part.part_name;
		const detail = document.createElement('span');
		detail.className = 'block text-sm text-gray-600';
		detail.textContent = `${part.barcode}${part.description ? ` — ${part.description}` : ''}`;
		btn.append(name, detail);
		btn.addEventListener('click', () => {
			selectBarcode(part.barcode, true).catch(error => setStatus(error.message, true));
		});
		item.appendChild(btn);
		list.appendChild(item);
	});
	if (matches.length > 20) {
		const item = document.createElement('li');
		item.className = 'text-sm text-gray-600';
		item.textContent = `Showing 20 of ${matches.length} matches. Type more to narrow the search.`;
		list.appendChild(item);
	}
}

function findPartByBarcode(barcode) {
	const direct = parts.find(part => part.barcode === barcode);
	if (direct) return direct;
	const alias = aliases.find(item => item.alias === barcode);
	return alias ? parts.find(part => part.barcode === alias.barcode) : undefined;
}

function renderLinkResults() {
	const terms = byId('link-search-input').value.toLowerCase().split(/\s+/).filter(Boolean);
	const list = byId('link-results');
	list.replaceChildren();
	if (!terms.length) return;
	const matches = parts.filter(part => {
		const text = `${part.part_name} ${part.description} ${part.barcode}`.toLowerCase();
		return terms.every(term => text.includes(term));
	});
	if (!matches.length) {
		const item = document.createElement('li');
		item.className = 'text-sm text-gray-600';
		item.textContent = 'No matching parts.';
		list.appendChild(item);
		return;
	}
	matches.slice(0, 10).forEach(part => {
		const item = document.createElement('li');
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'w-full text-left border rounded px-2 py-2 hover:bg-gray-100';
		const name = document.createElement('span');
		name.className = 'font-semibold';
		name.textContent = part.part_name;
		const detail = document.createElement('span');
		detail.className = 'block text-sm text-gray-600';
		detail.textContent = `${part.barcode}${part.description ? ` — ${part.description}` : ''}`;
		btn.append(name, detail);
		btn.addEventListener('click', () => {
			linkBarcodeToPart(part).catch(error => setStatus(error.message, true));
		});
		item.appendChild(btn);
		list.appendChild(item);
	});
}

async function linkBarcodeToPart(part) {
	const alias = byId('barcode-value').textContent;
	if (!currentUser || !alias) return;
	if (!navigator.onLine) {
		setStatus('Linking a barcode to an existing part requires an internet connection.', true);
		return;
	}
	const { data, error } = await supabaseClient.from('part_barcodes')
		.insert({ alias, barcode: part.barcode, created_by: currentUser.id })
		.select('alias, barcode')
		.single();
	if (error) {
		setStatus(error.code === '23505'
			? 'This barcode is already linked to a part. Reload and look it up again.'
			: `Could not link the barcode: ${error.message}. Make sure the barcode link SQL has been run in Supabase.`, true);
		return;
	}
	aliases.push(data);
	await saveOfflineSnapshot(currentUser.id).catch(() => {});
	setStatus(`Barcode ${alias} linked to ${part.part_name}.`);
	await selectBarcode(alias, true);
}

async function fetchAllParts() {
	const pageSize = 1000;
	const all = [];
	for (let from = 0; ; from += pageSize) {
		const { data, error } = await supabaseClient.from('parts')
			.select('*')
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
			await syncPendingParts();
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
		const aliasResult = await supabaseClient.from('part_barcodes').select('alias, barcode').limit(100000);
		if (!aliasResult.error) aliases = aliasResult.data;
		await mergePendingParts(currentUser.id);
		byId('parts-count').textContent = `Parts available to look up: ${parts.length}`;
		if (assignmentsResult.error) {
			syncError ??= assignmentsResult.error;
		} else {
			assignments = assignmentsResult.data;
		}
		renderAssignments();
		loadStockCounts().catch(() => {});
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
		aliases = [];
		byId('part-search-input').value = '';
		byId('part-search-results').replaceChildren();
		byId('parts-count').textContent = '';
		assignments = [];
		renderPart(null);
		byId('logs-table-body').replaceChildren();
		byId('barcode-value').textContent = '';
		byId('barcode-input').value = '';
		endPick();
		endCount();
		stockCounts = [];
		byId('counts-table-body').replaceChildren();
		setNewPartUi(false);
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
		setNewPartUi(false);
		setStatus(`Enter a barcode of 1 to ${maximumBarcodeLength} characters.`, true);
		return;
	}
	if (!forceLookup && !activePick && !activeCount && barcode === byId('barcode-value').textContent) return;

	lookupRequest += 1;
	byId('barcode-value').textContent = barcode;
	byId('barcode-input').value = barcode;
	const existingPart = findPartByBarcode(barcode);
	if (existingPart) {
		renderPart(existingPart);
		if (activePick || activeCount) {
			addScanned(existingPart, !forceLookup);
			return;
		}
		setStatus(`Found: ${existingPart.part_name} — ${existingPart.description || 'no description'}. Start a pick or stock take to record it.`);
		return;
	}

	byId('part-name').textContent = '';
	byId('part-desc').textContent = '';
	setNewPartUi(false);

	showUnknownBarcode(navigator.onLine
		? 'Not found in your parts list. Enter the part details to add it.'
		: 'Not found in the saved parts list. Enter the part details to save it on this device; it will upload when you are back online.');
}

async function addPart(event) {
	event.preventDefault();
	if (!currentUser || !byId('barcode-value').textContent) return;
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

	const saveOffline = async () => {
		const queued = await queueOfflinePart(part);
		renderPart(queued);
		setStatus('Part saved on this device. It will be added to the shared list when you are back online.');
		addScanned(queued, false);
	};
	if (!navigator.onLine) {
		await saveOffline();
		return;
	}

	let result;
	try {
		result = await supabaseClient.from('parts').insert(part)
			.select('barcode, part_name, description')
			.single();
	} catch (error) {
		if (isNetworkFailure(error)) {
			await saveOffline();
			return;
		}
		throw error;
	}
	const { data, error } = result;
	if (error) {
		if (!navigator.onLine || isNetworkFailure(error)) {
			await saveOffline();
			return;
		}
		setStatus(error.code === '23505'
			? 'Another user has already added this barcode. Refresh the shared list and look it up again.'
			: `Could not add the part: ${error.message}`, true);
		return;
	}

	if (!findPartByBarcode(data.barcode)) parts.push(data);
	renderPart(data);
	await saveOfflineSnapshot(currentUser.id).catch(() => {});
	setStatus('Part added to the shared parts list.');
	addScanned(data, false);
}

let activePick = null;
let activeCount = null;
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
	if (activeCount) {
		setStatus('Finish the stock take before starting a pick.', true);
		return;
	}
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
	byId('photo-input').addEventListener('change', event => {
		const file = event.target.files[0];
		event.target.value = '';
		savePartPhoto(file).catch(error => setStatus(error.message, true));
	});
	byId('link-search-input').addEventListener('input', renderLinkResults);
	byId('part-search-form').addEventListener('submit', searchParts);
	byId('part-search-input').addEventListener('input', searchParts);
	byId('new-part-form').addEventListener('submit', event => {
		addPart(event).catch(error => setStatus(error.message, true));
	});
	byId('pick-form').addEventListener('submit', startPick);
	byId('pick-complete-btn').addEventListener('click', () => {
		completePick().catch(error => setStatus(error.message, true));
	});
	byId('export-btn').addEventListener('click', exportAssignmentsToCSV);
	window.addEventListener('hashchange', applyView);
	applyView();
	byId('count-form').addEventListener('submit', startCount);
	byId('count-complete-btn').addEventListener('click', () => {
		finishCount().catch(error => setStatus(error.message, true));
	});
	byId('export-counts-btn').addEventListener('click', exportCountsToCSV);

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

// ---- Stock take ----
function addScanned(part, isCameraScan) {
	if (activePick) addToPick(part, isCameraScan);
	else if (activeCount) addToCount(part, isCameraScan);
}

function renderCount() {
	byId('count-form').classList.toggle('hidden', Boolean(activeCount));
	byId('count-active').classList.toggle('hidden', !activeCount);
	byId('active-count-name').textContent = activeCount?.name ?? '';
	const tbody = byId('count-items-body');
	tbody.replaceChildren();
	const items = activeCount ? [...activeCount.items.values()] : [];
	byId('count-empty').classList.toggle('hidden', items.length > 0);
	items.forEach(item => {
		const row = document.createElement('tr');
		appendCell(row, item.part.barcode);
		appendCell(row, item.part.part_name);
		const qtyCell = document.createElement('td');
		qtyCell.className = 'border px-2 py-1';
		const input = document.createElement('input');
		input.type = 'number';
		input.min = '0';
		input.step = '1';
		input.value = String(item.qty);
		input.className = 'w-20 border rounded px-2 py-1';
		input.setAttribute('aria-label', `Counted quantity for ${item.part.part_name}`);
		input.addEventListener('change', () => {
			const qty = Math.floor(Number(input.value));
			item.qty = Number.isFinite(qty) && qty >= 0 ? qty : item.qty;
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
			activeCount.items.delete(item.part.barcode);
			renderCount();
		});
		removeCell.appendChild(removeBtn);
		row.appendChild(removeCell);
		tbody.appendChild(row);
	});
}

function startCount(event) {
	event.preventDefault();
	if (activePick) {
		setStatus('Complete the pick before starting a stock take.', true);
		return;
	}
	const name = byId('count-name-input').value.trim();
	if (!name) {
		setStatus('Enter a stock take name or location.', true);
		return;
	}
	activeCount = { name, items: new Map() };
	lastPickScan = { barcode: '', time: 0 };
	renderCount();
	setStatus('Stock take started. Each scan adds 1 to the counted quantity; adjust counts before finishing.');
}

function endCount() {
	activeCount = null;
	byId('count-name-input').value = '';
	renderCount();
}

function addToCount(part, isCameraScan) {
	const now = Date.now();
	if (isCameraScan && lastPickScan.barcode === part.barcode && now - lastPickScan.time < duplicateScanWindowMs) {
		lastPickScan.time = now;
		return;
	}
	lastPickScan = { barcode: part.barcode, time: now };
	const item = activeCount.items.get(part.barcode);
	if (item) item.qty += 1;
	else activeCount.items.set(part.barcode, { part, qty: 1 });
	renderCount();
	setStatus(`Counted: ${part.part_name} — ${activeCount.items.get(part.barcode).qty}.`);
}

function renderStockCounts() {
	const tbody = byId('counts-table-body');
	tbody.replaceChildren();
	stockCounts.forEach(count => {
		const row = document.createElement('tr');
		appendCell(row, new Date(count.created_at).toLocaleString());
		appendCell(row, count.count_name);
		appendCell(row, count.pending_offline ? 'Pending sync' : 'Synced');
		appendCell(row, count.barcode);
		appendCell(row, count.part_name);
		appendCell(row, count.counted_qty);
		appendCell(row, count.counted_by || count.created_by);
		tbody.appendChild(row);
	});
}

async function saveCount(record) {
	const queue = async () => {
		record.pending_offline = true;
		await offlineStore('pending_counts', 'readwrite', store => store.put(record));
		stockCounts.unshift(record);
		return true;
	};
	if (!navigator.onLine) return queue();
	let result;
	try {
		result = await supabaseClient.from('stock_counts').insert(record).select(countColumns).single();
	} catch (error) {
		if (isNetworkFailure(error)) return queue();
		throw error;
	}
	if (result.error) {
		if (!navigator.onLine || isNetworkFailure(result.error)) return queue();
		setStatus(`Could not save the stock count: ${result.error.message}. Make sure the stock count SQL has been run in Supabase.`, true);
		return false;
	}
	stockCounts.unshift(result.data);
	return true;
}

async function finishCount() {
	if (!currentUser || !activeCount) return;
	const { name, items } = activeCount;
	if (!items.size) {
		endCount();
		setStatus('Stock take ended with no parts counted.');
		return;
	}
	byId('count-complete-btn').disabled = true;
	try {
		const createdAt = new Date().toISOString();
		for (const item of [...items.values()]) {
			const saved = await saveCount({
				id: crypto.randomUUID(),
				created_at: createdAt,
				count_name: name,
				barcode: item.part.barcode,
				part_name: item.part.part_name,
				description: item.part.description,
				counted_qty: item.qty,
				created_by: currentUser.id,
				counted_by: currentUser.email
			});
			if (!saved) {
				renderCount();
				renderStockCounts();
				return;
			}
			items.delete(item.part.barcode);
		}
		renderStockCounts();
		endCount();
		setStatus(navigator.onLine ? `Stock take "${name}" saved.` : `Stock take "${name}" saved on this device. It will sync when you are back online.`);
	} finally {
		byId('count-complete-btn').disabled = false;
	}
}

async function syncPendingCounts() {
	if (!currentUser || !navigator.onLine) return;
	const pending = await offlineStore('pending_counts', 'readonly', store => store.getAll());
	for (const record of pending.filter(item => item.created_by === currentUser.id)) {
		const { pending_offline, ...row } = record;
		const { error } = await supabaseClient.from('stock_counts').insert(row);
		if (error && error.code !== '23505') throw error;
		await offlineStore('pending_counts', 'readwrite', store => store.delete(record.id));
	}
}

async function loadStockCounts() {
	if (!navigator.onLine) return;
	await syncPendingCounts().catch(() => {});
	const { data, error } = await supabaseClient.from('stock_counts').select(countColumns)
		.order('created_at', { ascending: false }).limit(1000);
	if (error) return;
	stockCounts = data;
	renderStockCounts();
}

function exportCountsToCSV() {
	if (!stockCounts.length) {
		setStatus('There are no stock counts to export.');
		return;
	}
	const headers = ['Timestamp', 'Stock Take', 'Barcode', 'Part Name', 'Description', 'Counted Qty', 'Counted By'];
	const rows = stockCounts.map(count => [count.created_at, count.count_name, count.barcode, count.part_name, count.description, count.counted_qty, count.counted_by || count.created_by]);
	const csv = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
	const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = 'stock_counts.csv';
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---- Page navigation ----
function applyView() {
	const view = location.hash === '#stock-take' ? 'stock' : 'pick';
	document.querySelectorAll('[data-view]').forEach(element => {
		element.classList.toggle('hidden', element.dataset.view !== view);
	});
	[['nav-pick', 'pick'], ['nav-stock', 'stock']].forEach(([id, name]) => {
		const active = name === view;
		byId(id).classList.toggle('bg-blue-600', active);
		byId(id).classList.toggle('text-white', active);
		byId(id).classList.toggle('bg-white', !active);
		byId(id).classList.toggle('text-gray-900', !active);
		byId(id).setAttribute('aria-current', active ? 'page' : 'false');
	});
	document.title = view === 'stock' ? 'Stock Take' : 'Part Assignment App';
}
