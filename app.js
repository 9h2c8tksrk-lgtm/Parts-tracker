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

const byId = id => document.getElementById(id);

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
		appendCell(row, assignment.barcode);
		appendCell(row, assignment.part_name);
		appendCell(row, assignment.description);
		appendCell(row, assignment.stock_level);
		appendCell(row, assignment.assigned_by || assignment.created_by);
		tbody.appendChild(row);
	});
}

function renderPart(part) {
	selectedPart = part;
	byId('part-name').textContent = part?.part_name ?? '';
	byId('part-desc').textContent = part?.description ?? '';
	byId('part-stock').textContent = part ? String(part.stock_level) : '';
	byId('new-part-form').classList.toggle('hidden', Boolean(part));
	byId('assignment-form').classList.toggle('hidden', !part);
}

function findPartByBarcode(barcode) {
	return parts.find(part => part.barcode === barcode);
}

async function loadSharedData() {
	setStatus('Loading shared parts and assignments...');
	const [partsResult, assignmentsResult] = await Promise.all([
		supabaseClient.from('parts').select('barcode, part_name, description, stock_level').order('part_name'),
		supabaseClient.from('assigned_parts')
			.select('id, created_at, wo_number, barcode, part_name, description, stock_level, created_by, assigned_by')
			.order('created_at', { ascending: false })
			.limit(1000)
	]);

	if (partsResult.error) {
		setStatus(`Could not load the shared parts list: ${partsResult.error.message}`, true);
		return;
	}
	if (assignmentsResult.error) {
		setStatus(`Could not load the shared assignment log: ${assignmentsResult.error.message}`, true);
		return;
	}

	parts = partsResult.data;
	assignments = assignmentsResult.data;
	renderAssignments();
	setStatus('');
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
		assignments = [];
		renderPart(null);
		byId('logs-table-body').replaceChildren();
		byId('barcode-value').textContent = '';
		byId('barcode-input').value = '';
		byId('wo-input').value = '';
		byId('new-part-form').classList.add('hidden');
		byId('assignment-form').classList.add('hidden');
		if (html5QrCode?.isScanning) {
			html5QrCode.stop().catch(error => setStatus(`Could not stop the camera: ${error.message}`, true));
		}
		return;
	}

	loadSharedData().catch(error => setStatus(`Could not load shared data: ${error.message}`, true));
	subscribeToSharedChanges();
	startScanner();
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
	const headers = ['Timestamp', 'WO Number', 'Barcode', 'Part Name', 'Description', 'Stock Level', 'Assigned By'];
	const rows = assignments.map(assignment => [
		assignment.created_at,
		assignment.wo_number,
		assignment.barcode,
		assignment.part_name,
		assignment.description,
		assignment.stock_level,
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
	byId('new-part-stock').value = '0';
	setStatus(message);
}

async function lookupInternet(barcode, requestId) {
	setStatus('Searching UPCitemdb for a matching product...');
	try {
		const { data, error } = await supabaseClient.functions.invoke('lookup-barcode', { body: { barcode } });
		if (error) throw error;
		if (requestId !== lookupRequest) return;

		if (!data?.found) {
			showUnknownBarcode('No public match was found. Enter the part details to add it to the shared list.');
			return;
		}

		byId('new-part-name').value = data.partName;
		byId('new-part-desc').value = [data.brand, data.description]
			.filter(Boolean)
			.join(' — ')
			.slice(0, 2000);
		byId('new-part-stock').value = '0';
		renderPart(null);
		setStatus('A possible match was found. Review the details and stock level before adding it.');
	} catch (error) {
		if (requestId !== lookupRequest) return;
		showUnknownBarcode(`${error.message} Enter the part details manually to add it.`);
	}
}

async function selectBarcode(rawBarcode, forceLookup = false) {
	const barcode = rawBarcode.trim();
	if (!barcode || barcode.length > maximumBarcodeLength) {
		lookupRequest += 1;
		byId('barcode-value').textContent = '';
		byId('part-name').textContent = '';
		byId('part-desc').textContent = '';
		byId('part-stock').textContent = '';
		byId('new-part-form').classList.add('hidden');
		byId('assignment-form').classList.add('hidden');
		setStatus(`Enter a barcode of 1 to ${maximumBarcodeLength} characters.`, true);
		return;
	}
	if (!forceLookup && barcode === byId('barcode-value').textContent) return;

	lookupRequest += 1;
	const requestId = lookupRequest;
	byId('barcode-value').textContent = barcode;
	byId('barcode-input').value = barcode;
	const existingPart = findPartByBarcode(barcode);
	if (existingPart) {
		renderPart(existingPart);
		setStatus('Part found in the shared list.');
		return;
	}

	byId('part-name').textContent = '';
	byId('part-desc').textContent = '';
	byId('part-stock').textContent = '';
	byId('new-part-form').classList.add('hidden');
	byId('assignment-form').classList.add('hidden');

	if (!/^\d{8,14}$/.test(barcode)) {
		showUnknownBarcode('This barcode is not a UPC/EAN/GTIN format supported by the public lookup. Enter the part details manually.');
		return;
	}
	await lookupInternet(barcode, requestId);
}

async function addPart(event) {
	event.preventDefault();
	if (!currentUser || !byId('barcode-value').textContent) return;

	const barcode = byId('barcode-value').textContent;
	const part = {
		barcode,
		part_name: byId('new-part-name').value.trim(),
		description: byId('new-part-desc').value.trim(),
		stock_level: Number(byId('new-part-stock').value)
	};
	if (!part.part_name || !Number.isInteger(part.stock_level) || part.stock_level < 0) {
		setStatus('Enter a part name and a whole-number stock level of zero or more.', true);
		return;
	}

	const { data, error } = await supabaseClient.from('parts').insert(part)
		.select('barcode, part_name, description, stock_level')
		.single();
	if (error) {
		setStatus(error.code === '23505'
			? 'Another user has already added this barcode. Refresh the shared list and look it up again.'
			: `Could not add the part: ${error.message}`, true);
		return;
	}

	if (!findPartByBarcode(data.barcode)) parts.push(data);
	renderPart(data);
	setStatus('Part added to the shared parts list.');
}

async function assignPart(event) {
	event.preventDefault();
	if (!currentUser || !selectedPart) return;

	const woNumber = byId('wo-input').value.trim();
	if (!woNumber) {
		setStatus('Enter a work order number before assigning the part.', true);
		return;
	}
	const newAssignment = {
		wo_number: woNumber,
		barcode: selectedPart.barcode,
		part_name: selectedPart.part_name,
		description: selectedPart.description,
		stock_level: selectedPart.stock_level,
		created_by: currentUser.id,
		assigned_by: currentUser.email
	};
	const { data, error } = await supabaseClient.from('assigned_parts').insert(newAssignment)
		.select('id, created_at, wo_number, barcode, part_name, description, stock_level, created_by, assigned_by')
		.single();
	if (error) {
		setStatus(`Could not save the assignment: ${error.message}`, true);
		return;
	}

	if (!assignments.some(assignment => assignment.id === data.id)) assignments.push(data);
	assignments.sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
	assignments = assignments.slice(0, 1000);
	renderAssignments();
	setStatus('Part assignment saved for all users.');
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

async function startScanner() {
	if (!currentUser || scannerStarting || typeof Html5Qrcode === 'undefined' || html5QrCode?.isScanning) return;
	scannerStarting = true;
	try {
		html5QrCode ??= new Html5Qrcode('qr-reader');
		const cameras = await Html5Qrcode.getCameras();
		if (!currentUser) return;
		if (!cameras?.length) {
			setStatus('No camera was found. You can enter a barcode manually.');
			return;
		}
		await html5QrCode.start(
			{ facingMode: 'environment' },
			{ fps: 10, qrbox: 250 },
			decodedText => selectBarcode(decodedText),
			() => {}
		);
	} catch (error) {
		setStatus(`Camera unavailable: ${error.message}. You can enter a barcode manually.`);
	} finally {
		scannerStarting = false;
	}
}

document.addEventListener('DOMContentLoaded', async () => {
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
	byId('assignment-form').addEventListener('submit', event => {
		assignPart(event).catch(error => setStatus(error.message, true));
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
