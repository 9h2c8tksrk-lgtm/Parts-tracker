# Parts-tracker

## Features

- Shared part catalog and assignment log, updated live for signed-in users.
- Optional asset number recorded with each part assignment.
- Email/password sign-up, sign-in, and sign-out.
- Camera scanning or manual entry of UPC, EAN, and GTIN barcodes.
- Authenticated barcode lookup through UPCitemdb. Results are suggestions that users review before adding.
- CSV export of the shared assignment log.
- Offline access to the previously loaded catalog and assignment log, with queued assignment sync.

The public UPCitemdb Explorer service allows 100 combined requests per day and up to 6 requests per minute; its free-tier limits are IP-based. Public lookup coverage is incomplete, especially for industrial parts; unmatched barcodes can be added manually.

## Offline use

Open the app online at its HTTPS address (or `localhost`) at least once, sign in, and allow the app and its data to load. After that, a previously signed-in user can reopen it without internet, view the last saved parts and assignment log, scan or enter barcodes in that saved catalog, and queue part assignments on the device. Queued assignments sync automatically when the connection returns and the signed-in session is still valid. Keep the app open briefly after reconnecting to let synchronization finish.

Offline mode does not support first-time sign-in, adding parts to the shared catalog, UPCitemdb lookups, or live updates from other users. Cached data and pending assignments are stored in that browser on that device; they are not a backup or shared until synchronization succeeds. Browser storage can be cleared by device or browser settings.

## Importing the item reference list

`python3 scripts/build_parts_list.py` converts `Item Reference List.csv.xlsx` into `master_parts_list.json` (needs `pandas` and `openpyxl`). Load it into the shared catalog with:

```sh
SUPABASE_URL=https://YOUR-PROJECT.supabase.co SUPABASE_SERVICE_ROLE_KEY=YOUR-SERVICE-ROLE-KEY python3 scripts/import_parts.py
```

Existing barcodes are skipped, so stock levels and manual edits are kept. The service role key bypasses RLS; use it only in your shell, never in `config.js`.

## Supabase setup

1. Create a Supabase project.
2. Open the project's SQL Editor and run [`supabase/schema.sql`](./supabase/schema.sql). It creates or updates the shared tables, row-level security policies, and two sample parts.
3. Copy the project URL and its public publishable/anon key into `config.js`:

   ```js
   window.SUPABASE_CONFIG = {
     url: 'https://YOUR-PROJECT.supabase.co',
     anonKey: 'YOUR-PUBLIC-PUBLISHABLE-OR-ANON-KEY'
   };
   ```

   The key is intended for browser use. Never put a `service_role` or secret key in this file. Database access is restricted by the RLS policies in the SQL schema.
4. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and authenticate, then deploy the lookup function from this repository:

   ```sh
   supabase link --project-ref YOUR-PROJECT-REF
   supabase functions deploy lookup-barcode
   ```

   Supabase supplies the function's project URL and anon key automatically. The function requires a valid signed-in user and calls UPCitemdb server-side because that service does not allow browser requests from this app's origin.
5. In Supabase Authentication settings, configure the site's URL and allowed redirect URLs for where you host the app. Configure sign-up policy to match your organization. Anyone allowed to create an account can see and update the shared parts list and read the shared assignment log.
6. Serve the app from `localhost` or an HTTPS host (camera access is not available from an ordinary `file://` URL). For example, from this directory run `python3 -m http.server 8000`, then open `http://localhost:8000`.

The app's frontend dependencies are loaded from public CDNs. All signed-in users share the same parts and assignment records; each assignment records the authenticated user's email. Part details returned by UPCitemdb are not authoritative, so review them before saving.