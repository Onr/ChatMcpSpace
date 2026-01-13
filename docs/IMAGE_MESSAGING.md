# Image Messaging (Agent ↔ User) — Implementation Notes

This project currently supports **text-only** messaging:
- **Agent → User**: `POST /api/agent/messages` (and `POST /api/agent/questions`)
- **User → Agent**: `POST /api/user/messages` (free-text), plus `POST /api/user/responses` (question answers)
- **User reads**: `GET /api/user/messages/:agentId`
- **Agent reads**: `GET /api/agent/responses?agentName=...` (returns unread user messages + unread question responses)

To support **sending/receiving images**, avoid embedding base64 blobs in `content` (current validation caps content at ~100k chars and the UI assumes text). Instead, add **attachments** with upload + authenticated download.

---

## Goals

- Allow **agents and users** to attach one or more **images** to a message.
- Keep message endpoints mostly backwards-compatible (attachments optional).
- Keep image bytes out of the `GET /messages` responses (return metadata + URLs instead).
- Preserve the existing **auth model**:
  - Dashboard uses session cookies (`/api/user/*`)
  - Agents use API key (`/api/agent/*`)
- Maintain the existing **E2E security model**: the server stores only **encrypted image bytes** and never decrypts them.

---

## Recommended Data Model

### Option A (recommended): Attachment rows + join tables

Add a generic attachment table and two join tables (one for each message table):

- `attachments`
  - `attachment_id` (uuid pk)
  - `content_type` (e.g. `image/png`, `image/jpeg`, `image/webp`)
  - `file_name` (optional)
  - `size_bytes`
  - `sha256` (optional but useful for dedupe/integrity)
  - `storage_provider` (`local` | `s3` | …)
  - `storage_key` (path/key in the storage provider)
  - `encrypted` (boolean; if ciphertext stored)
  - `width`, `height` (optional; extracted server-side)
  - `created_at`

- `message_attachments`
  - `message_id` → `messages.message_id` (cascade)
  - `attachment_id` → `attachments.attachment_id` (cascade)
  - `attachment_order` (int)

- `user_message_attachments`
  - `user_message_id` → `user_messages.user_message_id` (cascade)
  - `attachment_id` → `attachments.attachment_id` (cascade)
  - `attachment_order` (int)

This keeps the current `messages` / `user_messages` schema stable and avoids polymorphic foreign keys.

### Upload staging (needed)

Because uploads happen **before** message creation (and you’ll want progress UI), you also need a staging mechanism:

- Minimal approach: store `agent_id`, `uploaded_by` (`user|agent`), and `is_attached` / `attached_at` on `attachments`.
- Better approach: separate `attachment_uploads` table with TTL cleanup.

The key requirement: when associating `attachmentId`s to a message, enforce that the uploader is authorized and the attachment belongs to the correct `agent_id` context.

---

## Backend Changes

### 1) Storage layer

Implement a small storage abstraction (local disk first, S3 later):

- Local provider:
  - Store under something like `./uploads/<userId>/<agentId>/<attachmentId>`
  - Do **not** serve directly from `public/` (must enforce auth)
- S3 provider (later):
  - Store objects with a prefix like `users/<userId>/agents/<agentId>/<attachmentId>`
  - Download via signed URLs or proxy download endpoint

E2E note:
- Stored bytes are **ciphertext** only. The server must never decrypt to generate thumbnails/transforms.
- Any resizing/transcoding (e.g. to WebP) must happen **client/agent-side before encryption and upload**.

### 2) Upload endpoints

Add endpoints for uploading a single image file (multipart) and returning an `attachmentId`.

- User upload (session auth):
  - `POST /api/user/attachments`
  - multipart fields: `agentId`, `file`

- Agent upload (API key auth):
  - `POST /api/agent/attachments`
  - multipart fields: `agentName` (or `agentId`), `file`

Response shape (example):
```json
{
  "attachmentId": "uuid",
  "contentType": "image/png",
  "sizeBytes": 12345,
  "width": 512,
  "height": 512,
  "encrypted": true,
  "encryption": {
    "alg": "AES-GCM",
    "ivBase64": "base64",
    "tagBase64": "base64"
  }
}
```

Validation and safety:
- Enforce max size (e.g. `MAX_IMAGE_BYTES=5_000_000`)
- Enforce allowlist MIME types and verify by magic bytes (don’t trust headers)
- Normalize/strip filenames, never trust user-provided paths
- Consider basic malware scanning hook (optional)
- Enforce `encrypted=true` uploads (ciphertext only); store `content_type` as the *original* image MIME type for rendering after decrypt.

### 3) Download endpoints

Serve the **ciphertext bytes** via authenticated endpoints:

- User download:
  - `GET /api/user/attachments/:attachmentId`
  - Authorize by joining attachment → (message|user_message) → agent → user

- Agent download:
  - `GET /api/agent/attachments/:attachmentId`
  - Authorize by joining attachment → agent → api-key user

HTTP behavior:
- Prefer `Content-Type: application/octet-stream` (ciphertext); clients render using the `contentType` metadata from message payload after decrypt.
- `Cache-Control`:
  - Ciphertext can be cached, but treat as user-specific data: `private, max-age=...` (or `no-store` if you want to minimize leakage on shared devices)
- `Content-Disposition: inline; filename="..."` (optional)

### 4) Message creation endpoints accept attachments

Extend existing JSON endpoints with an optional `attachmentIds` array:

- `POST /api/agent/messages`:
  - accept `attachmentIds?: string[]`
  - allow `content` to be empty **only if** attachments exist (requires changing `validateMessageContent` usage and relaxing `messages.content NOT NULL`)

- `POST /api/user/messages`:
  - accept `attachmentIds?: string[]`
  - allow `content` to be empty **only if** attachments exist (requires changing `validateMessageContent` usage and relaxing `user_messages.content NOT NULL`)

On insert, create rows in the appropriate join table.

### 5) Message retrieval endpoints include attachments metadata

Augment response objects (don’t inline bytes):

- `GET /api/user/messages/:agentId`: each message can include:
```json
{
  "attachments": [
    {
      "attachmentId": "uuid",
      "contentType": "image/png",
      "sizeBytes": 12345,
      "width": 512,
      "height": 512,
      "encrypted": true,
      "encryption": {
        "alg": "AES-GCM",
        "ivBase64": "base64",
        "tagBase64": "base64"
      },
      "downloadUrl": "/api/user/attachments/uuid"
    }
  ]
}
```

- `GET /api/agent/responses`: for `responseType: "text"` items, include `attachments` similarly, with `/api/agent/attachments/:id` URLs.

Implementation note: avoid N+1 queries by fetching attachments for all message IDs in one query and mapping in memory.

### 6) Schema + migrations

- Add new SQL migration(s) and update `src/db/schema.sql` accordingly.
- Ensure cascades delete attachments when the owning message is deleted.
- Add indexes:
  - `message_attachments(message_id)`
  - `user_message_attachments(user_message_id)`
  - (optional) `attachments(sha256)` for dedupe/integrity

---

## Frontend Changes (Dashboard)

### Composer (send)

Add an image picker to the existing message composer:
- `<input type="file" accept="image/*" multiple>` (or single-file first)
- Show preview thumbnails with remove buttons
- Upload workflow:
  1) Upload selected images → get `attachmentId`s
  2) Send message JSON with `content` + `attachmentIds`
  3) Refresh conversation (existing logic already reloads after send)

UI considerations:
- Show upload progress + failures per-file
- Allow sending text-only as before
- Allow image-only messages (if backend permits content empty when attachments exist)

### Conversation display (receive)

When rendering a message:
- If `attachments` present, do **not** use `<img src="downloadUrl">` (download is ciphertext).
- Instead: `fetch(downloadUrl)` → decrypt bytes client-side → `URL.createObjectURL(new Blob([plaintextBytes], { type: contentType }))` → set `<img src>` to that blob URL.
- Add click-to-open (modal/lightbox) and “download” link (download should export the decrypted bytes with the original filename/content type).

---

## Agent Loop / Agent Instructions

The generated agent helper (`src/utils/apiGuideGenerator.js`) currently talks JSON only.
To support images, update the guide + helper with two additions:

1) Upload helper
- `upload_image(path) -> attachmentId`
  - Calls `POST /api/agent/attachments` as multipart

2) Message helper changes
- `send_message(content, priority=0, attachment_ids=[...])`
- When polling `GET /api/agent/responses`, `responseType: "text"` may include `attachments`
  - Agent downloads ciphertext via `downloadUrl`, decrypts locally, then stores plaintext to disk for later processing.

Agent runtime guidance:
- Images can be large; prefer downloading to a temp folder and referencing paths.
- If running a vision-capable model, pass the downloaded image to the model according to the runner’s supported interface.
- Record attachments in `conversation_history.json` (e.g., store `attachmentId` + local saved path + metadata).

---

## End-to-End Encryption (E2E) for Images

Today, E2E encryption is implemented for **text** via the `encrypted` flag + client-side encrypt/decrypt.
For images, **E2E encryption is required**:
- The uploader (dashboard or agent) **compresses/transcodes as desired**, then encrypts the bytes client-side before upload.
- The server stores **ciphertext only** with `attachments.encrypted=true`.
- On download, the receiver (dashboard or agent) decrypts locally and renders/uses the plaintext bytes.

Implementation notes:
- Extend the frontend encryption module to encrypt/decrypt `ArrayBuffer` (not just strings).
- Extend the agent helper (Python) similarly (AES-GCM over bytes).
- Use the existing password+salt key derivation strategy to derive the same key for binary encryption.
- Store/return the AES-GCM `iv` and `authTag` for each attachment (either as DB columns or via a well-defined binary container format).
- Because the server cannot decrypt, any thumbnails must be generated and uploaded as separate (also encrypted) attachments or computed after download+decrypt.

---

## Testing Checklist

- Backend:
  - Upload rejects non-images and oversized files
  - Upload + attach flow works for both `/api/user/*` and `/api/agent/*`
  - Unauthorized download is blocked (wrong user / wrong agent)
  - Messages endpoints return attachment metadata and stable download URLs

- Frontend:
  - Upload UI works; previews render; remove works
  - Messages with attachments render correctly in conversation
  - Polling does not duplicate attachments

- Agent helper:
  - Can upload + send message with attachment IDs
  - Can receive attachments in `/api/agent/responses` and download them
