# ClosetVault

Your Closet. Secure Vault.

ClosetVault is a lightweight cloud storage and synchronization MVP built with a zero-dependency Node.js server and a polished browser UI. It lets users create an account, upload files, manage their vault, download files again, and prepare for future sharing workflows.

## What It Includes

- Account creation and sign-in
- Password hashing with `scrypt`
- Encrypted file storage at rest with `AES-256-GCM`
- File upload, listing, download, and deletion
- Responsive ClosetVault landing page and dashboard
- Smoke test covering register, upload, list, download, delete, and logout

## Project Structure

- `server.js`: HTTP server, auth routes, encrypted file storage routes, and static file serving
- `public/index.html`: ClosetVault marketing page and in-browser app shell
- `public/styles.css`: visual system and responsive layout
- `public/app.js`: client-side app logic for auth and file management
- `scripts/smoke-test.js`: end-to-end verification script

## Running Locally

```bash
npm start
```

ClosetVault starts on `http://127.0.0.1:3000` by default.

## Testing

```bash
npm test
```

## Environment Options

- `PORT`: server port, defaults to `3000`
- `HOST`: bind host, defaults to `127.0.0.1`
- `CLOSETVAULT_DATA_DIR`: override the on-disk storage directory
- `CLOSETVAULT_MAX_UPLOAD_MB`: per-file upload cap for the MVP, defaults to `10`

## Security Notes

- This MVP encrypts uploaded files at rest on the server.
- Sessions hold the derived vault key in memory after sign-in.
- Sharing, version history, and deeper synchronization controls are not implemented yet.
