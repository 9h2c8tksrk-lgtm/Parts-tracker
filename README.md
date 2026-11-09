# Parts-tracker

## Features

- Shared part catalog and assignment log, updated live for signed-in users.
- Optional asset number recorded with each part assignment.
- Email/password sign-up, sign-in, and sign-out.
- Camera scanning or manual entry of UPC, EAN, and GTIN barcodes.
- Authenticated barcode lookup through UPCitemdb. Results are suggestions that users review before adding.
- CSV export of the shared assignment log.

The public UPCitemdb Explorer service allows 100 combined requests per day and up to 6 requests per minute; its free-tier limits are IP-based. Public lookup coverage is incomplete, especially for industrial parts; unmatched barcodes can be added manually.

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