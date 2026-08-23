#!/usr/bin/env bash

# Display Google Auth Walkthrough

if ! command -v gum >/dev/null 2>&1; then
  echo "Gum is required."
  exit 1
fi

gum style \
  --border double \
  --margin "1 0" \
  --padding "1 2" \
  --border-foreground 212 \
  "Google Authentication Walkthrough" \
  "Verification & Troubleshooting Guide"

gum style --foreground 212 --bold "1. Prerequisites"
echo "Ensure you have updated your .env file with GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALLBACK_URL."

gum style --foreground 212 --bold "2. Database Migration"
echo "If you haven't run the migration yet, run this command manually (requires sudo):"
gum style --foreground 244 'sudo -u postgres psql -d agent_messaging_platform -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '"'users'"' AND column_name = '"'google_id'"') THEN ALTER TABLE users ADD COLUMN google_id VARCHAR(255) UNIQUE; END IF; END \$\$; ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL; CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);"'

gum style --foreground 212 --bold "3. Restart Server"
echo "You must restart the server to load the new Passport configuration."
echo "  > Stop server"
echo "  > Start server (production)"

gum style --foreground 212 --bold "4. Verify Google Sign-In"
echo "1. Go to your login page (e.g., https://chatmcp.space)."
echo "2. Click 'Sign in with Google'."
echo "3. Authenticate with Google."
echo "4. Expect redirection to the dashboard."

gum style --foreground 212 --bold "5. Troubleshooting"
gum style --foreground 214 "Redirect Mismatch Error?"
echo "Check GOOGLE_CALLBACK_URL in .env matches your Google Console exactly."
echo "  Prod: https://chatmcp.space/auth/google/callback"

gum style --foreground 214 "Database Error?"
echo "Check server logs. If 'column google_id does not exist', the migration failed."

echo ""
gum confirm "Done reading?" && exit 0
