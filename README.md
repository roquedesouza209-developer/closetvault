# ClosetVault

Your Closet. Secure Vault.

ClosetVault is a zero-dependency Node.js storage MVP with a Windows-like file explorer, encrypted object storage, and SQLite-backed file metadata.

## Current Features

- Account creation and sign-in
- Password hashing with `scrypt`
- Encrypted file storage at rest with `AES-256-GCM`
- Upload documents, images, videos, and audio files
- Drag-and-drop uploads with multiple-file support and progress UI
- Download, rename, move, delete, and restore files from Trash
- Preview images, MP4 videos, MP3 audio, and PDF documents inside the dashboard
- Generate secure share links for files
- Copy, replace, and revoke share links
- View or edit shared files by link with optional expiration and password protection
- "Shared with me" dashboard section for links opened while signed in
- Create, rename, and delete folders
- Grid view and list view
- Smart search across the vault using natural-language queries like "photos uploaded yesterday"
- Sort by name, date, and size
- Storage usage tracking
- S3-compatible storage adapter architecture with local filesystem storage by default

## Architecture

- `server.js`: application entrypoint
- `backend/config.js`: runtime configuration and limits
- `backend/storage.js`: filesystem and S3-compatible object storage adapters
- `backend/database.js`: SQLite metadata layer and migration helpers
- `backend/app.js`: HTTP routes, auth, explorer handlers, and static serving
- `public/index.html`: ClosetVault landing page and explorer shell
- `public/styles.css`: marketing and explorer UI styling
- `public/app.js`: browser-side explorer logic
- `public/share.html`: public shared-link page
- `public/share.js`: shared-link preview, download, and rename logic
- `scripts/smoke-test.js`: end-to-end explorer verification

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
- `CLOSETVAULT_DATA_DIR`: override the app data directory
- `CLOSETVAULT_MAX_UPLOAD_MB`: per-file upload cap, defaults to `50`
- `CLOSETVAULT_STORAGE_CAP_MB`: total storage cap per vault, defaults to `5120`
- `CLOSETVAULT_STORAGE_DRIVER`: `fs` or `s3`, defaults to `fs`
- `CLOSETVAULT_S3_ENDPOINT`: S3-compatible endpoint when `CLOSETVAULT_STORAGE_DRIVER=s3`
- `CLOSETVAULT_S3_BUCKET`: object storage bucket name
- `CLOSETVAULT_S3_ACCESS_KEY`: object storage access key
- `CLOSETVAULT_S3_SECRET_KEY`: object storage secret key
- `CLOSETVAULT_S3_REGION`: storage region, defaults to `us-east-1`
- `CLOSETVAULT_S3_FORCE_PATH_STYLE`: defaults to `true`

## Notes

- SQLite powers the explorer metadata. In Node.js 24 this uses the built-in experimental `node:sqlite` module, so you will see Node's experimental warning during startup and tests.
- Folder deletion currently requires the folder to be empty.
- Shared links use encrypted share snapshots so previews and downloads still work without the owner's live session key.
- The "Shared with me" list is populated when another signed-in ClosetVault user opens a shared link.
