import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...corsHeaders, "Content-Type": "application/json" },
	});
}

Deno.serve(async (request: Request) => {
	if (request.method === "OPTIONS") {
		return new Response("ok", { headers: corsHeaders });
	}
	if (request.method !== "POST") {
		return jsonResponse({ error: "Method not allowed." }, 405);
	}

	const authorization = request.headers.get("Authorization");
	if (!authorization) {
		return jsonResponse({ error: "Sign in to search for a barcode." }, 401);
	}

	const supabaseUrl = Deno.env.get("SUPABASE_URL");
	const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
	if (!supabaseUrl || !supabaseAnonKey) {
		console.error("Barcode lookup function is missing Supabase environment configuration.");
		return jsonResponse({ error: "Barcode lookup is not configured." }, 500);
	}

	const authenticatedClient = createClient(supabaseUrl, supabaseAnonKey, {
		global: { headers: { Authorization: authorization } },
	});
	const { data: userData, error: authError } = await authenticatedClient.auth.getUser();
	if (authError || !userData.user) {
		return jsonResponse({ error: "A valid signed-in session is required." }, 401);
	}

	let body: { barcode?: unknown };
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: "Request body must be valid JSON." }, 400);
	}
	if (typeof body.barcode !== "string" || !/^\d{8,14}$/.test(body.barcode)) {
		return jsonResponse({ error: "Barcode must contain 8 to 14 digits." }, 400);
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 8000);
	try {
		const response = await fetch(
			`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(body.barcode)}`,
			{ signal: controller.signal, headers: { Accept: "application/json" } },
		);
		if (response.status === 429) {
			return jsonResponse({ error: "The public barcode lookup limit has been reached. Add the part manually or try again later." }, 429);
		}
		if (!response.ok) {
			console.error(`UPCitemdb returned HTTP ${response.status}.`);
			return jsonResponse({ error: "The public barcode lookup service is temporarily unavailable." }, 502);
		}

		const result = await response.json();
		if (result.code === "TOO_FAST") {
			return jsonResponse({ error: "The public lookup burst limit has been reached. Wait before trying again." }, 429);
		}
		if (result.code !== "OK") {
			console.error(`UPCitemdb returned code ${String(result.code)}.`);
			return jsonResponse({ error: "The public barcode lookup service returned an unexpected response." }, 502);
		}
		const item = Array.isArray(result.items) ? result.items[0] : null;
		if (!item?.title || typeof item.title !== "string") {
			return jsonResponse({ found: false });
		}

		return jsonResponse({
			found: true,
			partName: item.title.slice(0, 200),
			brand: typeof item.brand === "string" ? item.brand.slice(0, 200) : "",
			description: typeof item.description === "string" ? item.description.slice(0, 2000) : "",
		});
	} catch (error) {
		console.error("UPCitemdb request failed.", error);
		return jsonResponse({ error: "Could not reach the public barcode lookup service." }, 502);
	} finally {
		clearTimeout(timeoutId);
	}
});
