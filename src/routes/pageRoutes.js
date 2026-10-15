/**
 * Page Routes
 * Handles all page rendering routes (registration, login, dashboard, settings)
 */

const express = require('express');
const router = express.Router();
const passport = require('passport');
const fs = require('fs');
const path = require('path');
const { registerUser, validateCredentials, createSession, destroySession, regenerateApiKey } = require('../services/authService');
const {
  buildOtpAuthUrl,
  disableUserMfa,
  enableUserTotp,
  generateTotpSecret,
  getUserMfaRecord,
  isPendingMfaExpired,
  isUserMfaEnabled,
  verifyTotpToken,
  verifyUserMfaCode,
  verifyUserTotpToken
} = require('../services/mfaService');
const { sendVerificationEmail, verifyEmailToken, verifyEmailCode, resendVerificationEmail, isEmailVerified } = require('../services/emailService');
const { protectRoute } = require('../middleware/authMiddleware');
const { authRateLimiter } = require('../middleware/rateLimitMiddleware');
const { csrfProtection, validateCsrfToken } = require('../middleware/csrfMiddleware');
const { logAuthenticationFailure } = require('../utils/securityLogger');
const { query } = require('../db/connection');
const { isValidEmail, validatePasswordStrength } = require('../utils/validation');
const { generateApiGuide, generateDirectSetupScript, generateMainCLIScript } = require('../utils/apiGuideGenerator');
const { generateEncryptionSalt } = require('../utils/encryptionHelper');
const { isLocalAuthMode } = require('../utils/localMode');
const { getProviderModelCatalog } = require('../utils/modelCatalog');
const { readPidFromFile, terminateProcessWithEscalation } = require('../utils/agentStopUtils');
const {
  DEFAULT_DASHBOARD_CONFIG,
  loadAgentRuntimeState,
  persistAgentRuntimeState,
  syncRuntimeStateToFilesystem
} = require('../services/agentRuntimeConfigService');
const MarbleGenerator = require('../../public/js/marble-generator');

const LANDING_DASHBOARD_PREVIEW_PATH = path.join(__dirname, '..', '..', 'data', 'landing-dashboard-preview.json');
const PREVIEW_COLOR_PALETTE = [
  'linear-gradient(135deg, #38bdf8, #2563eb)',
  'linear-gradient(135deg, #f97316, #ef4444)',
  'linear-gradient(135deg, #a855f7, #7c3aed)',
  'linear-gradient(135deg, #22c55e, #0f766e)',
  'linear-gradient(135deg, #f59e0b, #d97706)',
  'linear-gradient(135deg, #ec4899, #be185d)',
  'linear-gradient(135deg, #14b8a6, #0f766e)',
  'linear-gradient(135deg, #6366f1, #3730a3)'
];

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SHARING_INVITATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function getPendingSharingInvitationId(req) {
  const value = req.session?.pendingSharingInvitationId;
  return typeof value === 'string' && SHARING_INVITATION_ID_RE.test(value) ? value : null;
}
function dashboardInvitationUrl(req) {
  const invitationId = getPendingSharingInvitationId(req);
  if (!invitationId) return '/dashboard';
  delete req.session.pendingSharingInvitationId;
  return `/dashboard?invitationId=${encodeURIComponent(invitationId)}`;
}
function postLoginRedirectUrl(req) {
  const pending = req.session?.mcpOAuthReturnTo;
  const expiresAt = req.session?.mcpOAuthReturnToExpiresAt;
  delete req.session?.mcpOAuthReturnTo;
  delete req.session?.mcpOAuthReturnToExpiresAt;
  if (typeof pending === 'string' && pending.startsWith('/oauth/authorize?') && !pending.startsWith('//') && Number(expiresAt) > Date.now()) return pending;
  return dashboardInvitationUrl(req);
}

const DEFAULT_LANDING_PREVIEW_CONFIG = {
  renderMode: 'iframe',
  iframeUrl: '/dashboard-preview?embedded=1',
  iframeTitle: 'Live dashboard preview',
  agentTheme: 'Context → Options → Recommendation → Proof',
  focusedAgentId: 'system-architect',
  agents: [
    {
      agentId: 'system-architect',
      name: 'System Architect',
      agentType: 'standard',
      position: 1,
      highestPriority: 'normal',
      lastMessagePriority: 'normal',
      unreadCount: 1,
      lastMessageTime: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
      lastActivityTime: new Date(Date.now() - 1000 * 60 * 1).toISOString()
    },
    {
      agentId: 'release-guardian',
      name: 'Release Guardian',
      agentType: 'standard',
      position: 2,
      highestPriority: 'high',
      lastMessagePriority: 'high',
      unreadCount: 2,
      lastMessageTime: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
      lastActivityTime: new Date(Date.now() - 1000 * 60 * 4).toISOString()
    },
    {
      agentId: 'product-researcher',
      name: 'Product Researcher',
      agentType: 'standard',
      position: 3,
      highestPriority: 'low',
      lastMessagePriority: 'low',
      unreadCount: 0,
      lastMessageTime: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
      lastActivityTime: new Date(Date.now() - 1000 * 60 * 10).toISOString()
    },
    {
      agentId: 'local-news',
      name: 'Local News',
      agentType: 'news_feed',
      position: 4,
      highestPriority: 'normal',
      lastMessagePriority: 'normal',
      unreadCount: 1,
      lastMessageTime: new Date(Date.now() - 1000 * 60 * 16).toISOString(),
      lastActivityTime: new Date(Date.now() - 1000 * 60 * 15).toISOString()
    },
    {
      agentId: 'ops-sentinel',
      name: 'Ops Sentinel',
      agentType: 'standard',
      position: 5,
      highestPriority: 'high',
      lastMessagePriority: 'high',
      unreadCount: 1,
      lastMessageTime: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
      lastActivityTime: new Date(Date.now() - 1000 * 60 * 19).toISOString()
    }
  ],
  conversations: [
    {
      agentId: 'system-architect',
      messages: [
        {
          role: 'user',
          content: 'Give me a 60-second triage: who needs me, and what decision should I make first?',
          priority: 2,
          createdAt: new Date(Date.now() - 1000 * 60 * 4).toISOString()
        },
        {
          role: 'assistant',
          content: 'Triage summary: Release Guardian is blocking ship (CI red). Product Researcher is compiling priorities (no action yet). Local News is monitoring. I recommend approving the smallest safe patch first, then replying to the release blocker.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 3).toISOString()
        },
        {
          role: 'user',
          content: 'What exactly should I reply to each agent?',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 2).toISOString()
        },
        {
          role: 'assistant',
          content: 'Reply template: Architect: "Proceed with the patch, include rollback." Guardian: "Fix the flake; include a fast verify command." Researcher: "Deliver top 3 insights + a 1-week plan." News: "Alert only for breaking changes affecting today."',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 1.5).toISOString()
        },
        {
          role: 'assistant',
          content: 'I will log your decision to the shared News Feed so every agent sees the same context and constraints.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 1).toISOString()
        }
      ]
    },
    {
      agentId: 'release-guardian',
      messages: [
        {
          role: 'user',
          content: 'Why is the release blocked?',
          priority: 3,
          createdAt: new Date(Date.now() - 1000 * 60 * 6).toISOString()
        },
        {
          role: 'assistant',
          content: 'CI is red on the release branch. I reproduced the flake and traced it to an async race. Safest fix is to add an explicit readiness check and remove timing assumptions from the test.',
          priority: 3,
          createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString()
        },
        {
          role: 'user',
          content: 'Give me the safest fix and how to verify quickly.',
          priority: 2,
          createdAt: new Date(Date.now() - 1000 * 60 * 4).toISOString()
        },
        {
          role: 'assistant',
          content: 'Fix: add a readiness probe in the harness, then run the single failing test and rerun CI. Rollback is a single revert if anything regresses.',
          priority: 2,
          createdAt: new Date(Date.now() - 1000 * 60 * 3).toISOString()
        },
        {
          role: 'assistant',
          content: 'If you approve, I will open the PR, run the checks, and post a green-light summary to the News Feed.',
          priority: 2,
          createdAt: new Date(Date.now() - 1000 * 60 * 2).toISOString()
        }
      ]
    },
    {
      agentId: 'product-researcher',
      messages: [
        {
          role: 'user',
          content: 'What should we build next to drive adoption?',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 14).toISOString()
        },
        {
          role: 'assistant',
          content: 'Top demand: (1) shared activity log (news feed), (2) per-agent instruction snippets, (3) triage UI that highlights "needs reply". These map directly to what visitors can understand in a 10-second demo.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 13).toISOString()
        },
        {
          role: 'user',
          content: 'Turn that into a 1-week plan with concrete deliverables.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString()
        },
        {
          role: 'assistant',
          content: 'Week plan: Day 1 landing stories + embedded preview. Day 2 news feed agent + schema. Day 3 filters + search. Day 4 docs + onboarding. Day 5 polish and dogfood.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 11).toISOString()
        },
        {
          role: 'assistant',
          content: 'I will write the landing copy and acceptance criteria so engineering can execute without guesswork.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 10).toISOString()
        }
      ]
    },
    {
      agentId: 'local-news',
      messages: [
        {
          role: 'user',
          content: 'Only notify me when it changes what we ship today.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 18).toISOString()
        },
        {
          role: 'assistant',
          content: 'Acknowledged. I will alert only for security advisories, upstream breaking changes, or incidents tied to your tracked dependencies.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 17).toISOString()
        },
        {
          role: 'user',
          content: 'Also watch for outages and API breaking changes.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 16).toISOString()
        },
        {
          role: 'assistant',
          content: 'Watching the relevant status pages and release notes. When something is material, I will post: what changed, impact, and recommended action.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 15.5).toISOString()
        },
        {
          role: 'assistant',
          content: 'Current scan: nothing critical. Next check in 15 minutes.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 15).toISOString()
        }
      ]
    },
    {
      agentId: 'ops-sentinel',
      messages: [
        {
          role: 'user',
          content: 'Any infra alerts I should care about right now?',
          priority: 2,
          createdAt: new Date(Date.now() - 1000 * 60 * 22).toISOString()
        },
        {
          role: 'assistant',
          content: 'Alert: server memory is at 90% and climbing (swap starting to rise). Disk is also tight due to logs and caches (for example: `/var/log/journal` and `/var/cache/apt/archives`). If this hits OOM, your agents will crash or stall.',
          priority: 3,
          createdAt: new Date(Date.now() - 1000 * 60 * 21).toISOString()
        },
        {
          role: 'user',
          content: 'Give me the safest quick fix and how to verify it worked.',
          priority: 2,
          createdAt: new Date(Date.now() - 1000 * 60 * 20).toISOString()
        },
        {
          role: 'assistant',
          content: 'Quick fix (safe): identify the top memory process with `ps aux --sort=-%mem | head` and restart only that service if needed. Reclaim space that drives swap thrash: check `sudo journalctl --disk-usage`, vacuum old logs (`sudo journalctl --vacuum-time=7d`), and clear apt cache (`sudo apt-get clean`). Verify: `free -h` shows memory back under ~75%, swap-in/out drops near 0, errors stay flat, and agents keep sending heartbeats.',
          priority: 2,
          createdAt: new Date(Date.now() - 1000 * 60 * 19).toISOString()
        },
        {
          role: 'assistant',
          content: 'Suggestion: add a memory alert threshold at 80% and a daily log retention policy. If you want zero babysitting, upgrade RAM and enable swap as a last-resort safety net.',
          priority: 1,
          createdAt: new Date(Date.now() - 1000 * 60 * 18.5).toISOString()
        }
      ]
    }
  ]
};

const { safeJsonForScript } = require('../utils/safeJsonHelper');

// Backwards-compatible name. Now escapes <, >, &, U+2028, U+2029 instead of
// just <, closing a script-tag-breakout gap noted in the security audit.
function toInlineScriptJSON(payload) {
  return safeJsonForScript(payload);
}

function asIsoDate(raw, fallbackDate) {
  const fallback = fallbackDate || new Date();
  if (typeof raw !== 'string') {
    return fallback.toISOString();
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return fallback.toISOString();
  }
  return parsed.toISOString();
}

function normalizePriority(raw, fallback) {
  if (raw === 'high' || raw === 'normal' || raw === 'low') {
    return raw;
  }
  return fallback;
}

function normalizeRole(raw) {
  if (raw === 'user' || raw === 'assistant' || raw === 'system') {
    return raw;
  }
  return 'assistant';
}

// Memoize the landing-preview config so we don't hit the disk on every
// landing-page request. Re-read when the file's mtime changes.
let landingPreviewConfigCache = null;
let landingPreviewConfigMtimeMs = 0;

function loadLandingPreviewConfigFile() {
  try {
    const stat = fs.statSync(LANDING_DASHBOARD_PREVIEW_PATH);
    if (landingPreviewConfigCache && stat.mtimeMs === landingPreviewConfigMtimeMs) {
      return landingPreviewConfigCache;
    }
    const fileText = fs.readFileSync(LANDING_DASHBOARD_PREVIEW_PATH, 'utf8');
    const parsed = JSON.parse(fileText);
    const config = parsed && typeof parsed === 'object'
      ? parsed
      : DEFAULT_LANDING_PREVIEW_CONFIG;
    landingPreviewConfigCache = config;
    landingPreviewConfigMtimeMs = stat.mtimeMs;
    return config;
  } catch (error) {
    console.warn('Failed to load landing dashboard preview config, using defaults:', error.message);
    return landingPreviewConfigCache || DEFAULT_LANDING_PREVIEW_CONFIG;
  }
}

function buildLandingDashboardPreviewModel() {
  const rawConfig = loadLandingPreviewConfigFile();
  const renderMode = rawConfig.renderMode === 'iframe' ? 'iframe' : 'inline';
  const iframeUrl = typeof rawConfig.iframeUrl === 'string' && rawConfig.iframeUrl.trim()
    ? rawConfig.iframeUrl.trim()
    : '/dashboard-preview?embedded=1';
  const iframeTitle = typeof rawConfig.iframeTitle === 'string' && rawConfig.iframeTitle.trim()
    ? rawConfig.iframeTitle.trim()
    : 'Live dashboard preview';

  const agentTheme = typeof rawConfig.agentTheme === 'string' && rawConfig.agentTheme.trim()
    ? rawConfig.agentTheme.trim()
    : DEFAULT_LANDING_PREVIEW_CONFIG.agentTheme;

  const rawAgents = Array.isArray(rawConfig.agents) && rawConfig.agents.length
    ? rawConfig.agents
    : DEFAULT_LANDING_PREVIEW_CONFIG.agents;

  const agents = rawAgents
    .map((agent, index) => {
      const agentIdValue = agent?.agentId || agent?.id || `agent-${index + 1}`;
      const agentId = String(agentIdValue).trim();
      if (!agentId) {
        return null;
      }

      const nameValue = agent?.name || `Agent ${index + 1}`;
      const name = String(nameValue).trim() || `Agent ${index + 1}`;
      const unreadCount = Number.isFinite(Number(agent?.unreadCount)) ? Math.max(0, Number(agent.unreadCount)) : 0;
      const lastMessagePriority = normalizePriority(agent?.lastMessagePriority, unreadCount > 0 ? 'normal' : 'low');
      const highestPriority = normalizePriority(agent?.highestPriority, lastMessagePriority);
      const position = Number.isFinite(Number(agent?.position)) ? Number(agent.position) : (index + 1);
      const fallbackTime = new Date(Date.now() - ((index + 1) * 1000 * 60 * 4));
      const lastMessageTime = asIsoDate(agent?.lastMessageTime, fallbackTime);
      const lastActivityTime = asIsoDate(agent?.lastActivityTime, fallbackTime);
      const avatarGradient = typeof agent?.avatarGradient === 'string' && agent.avatarGradient.trim()
        ? agent.avatarGradient.trim()
        : PREVIEW_COLOR_PALETTE[index % PREVIEW_COLOR_PALETTE.length];
      const ringRole = lastMessagePriority === 'high' ? 'urgent' : (lastMessagePriority === 'normal' ? 'attention' : 'idle');

      return {
        agentId,
        agentName: name,
        name,
        agentType: agent?.agentType === 'news_feed' ? 'news_feed' : 'standard',
        position,
        lastMessageId: `${agentId}-last-message`,
        lastMessageTime,
        lastActivityTime,
        unreadCount,
        highestPriority,
        lastMessagePriority,
        ringRole,
        avatarGradient,
        marbleSvg: MarbleGenerator.generateMarble(agentId, 100, name, `landing-preview-${index}`)
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.position || 0) - (b.position || 0));

  const messagesByAgent = {};

  const normalizeMessages = (agentId, rawMessages) => {
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return;
    }
    messagesByAgent[agentId] = rawMessages
      .map((message, index) => {
        if (!message || typeof message !== 'object') {
          return null;
        }
        const content = typeof message.content === 'string' ? message.content.trim() : '';
        if (!content) {
          return null;
        }
        const defaultTimestamp = new Date(Date.now() - (rawMessages.length - index) * 1000 * 60);
        const normalizedPriority = Number.isFinite(Number(message.priority)) ? Number(message.priority) : 1;
        return {
          messageId: message.messageId || `${agentId}-message-${index + 1}`,
          role: normalizeRole(message.role),
          content,
          priority: normalizedPriority,
          createdAt: asIsoDate(message.createdAt, defaultTimestamp)
        };
      })
      .filter(Boolean);
  };

  if (rawConfig.messagesByAgent && typeof rawConfig.messagesByAgent === 'object') {
    Object.entries(rawConfig.messagesByAgent).forEach(([agentId, rawMessages]) => {
      normalizeMessages(String(agentId), rawMessages);
    });
  }

  const rawConversations = Array.isArray(rawConfig.conversations) ? rawConfig.conversations : [];
  rawConversations.forEach((conversation, index) => {
    const agentIdValue = conversation?.agentId || conversation?.id || agents[index]?.agentId;
    if (!agentIdValue) {
      return;
    }
    normalizeMessages(String(agentIdValue), conversation.messages);
  });

  const fallbackFocusedAgentId = agents[0]?.agentId || null;
  const requestedFocusedId = typeof rawConfig.focusedAgentId === 'string' ? rawConfig.focusedAgentId.trim() : '';
  const focusedAgentId = agents.some(agent => agent.agentId === requestedFocusedId)
    ? requestedFocusedId
    : fallbackFocusedAgentId;

  if (focusedAgentId && (!messagesByAgent[focusedAgentId] || messagesByAgent[focusedAgentId].length === 0)) {
    const focusedAgent = agents.find(agent => agent.agentId === focusedAgentId);
    const focusedName = focusedAgent?.name || 'Agent';
    messagesByAgent[focusedAgentId] = [
      {
        messageId: `${focusedAgentId}-default-1`,
        role: 'assistant',
        content: `Ready to assist. I am ${focusedName}, standing by with your latest context and next actions.`,
        priority: 1,
        createdAt: new Date(Date.now() - 1000 * 60 * 2).toISOString()
      }
    ];
  }

  return {
    renderMode,
    iframeUrl,
    iframeTitle,
    agentTheme,
    focusedAgentId,
    agents,
    messagesByAgent
  };
}

function renderLandingPage(req, res, extraLocals = {}) {
  const landingDashboardPreview = buildLandingDashboardPreviewModel();
  return res.render('landing', {
    pageBodyClass: 'landing-page',
    error: null,
    email: '',
    landingDashboardPreview,
    ...extraLocals
  });
}

function getValidPendingMfa(req) {
  const pending = req.session?.pendingMfa;

  if (!pending) {
    return null;
  }

  if (isPendingMfaExpired(pending.createdAt)) {
    delete req.session.pendingMfa;
    return null;
  }

  return pending;
}

function clearPendingMfa(req) {
  if (!req.session) {
    return;
  }

  delete req.session.pendingMfa;
}

function clearPendingMfaSetup(req) {
  if (!req.session) {
    return;
  }

  delete req.session.pendingMfaSetup;
}

async function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function beginMfaChallenge(req, user, options = {}) {
  req.session.pendingMfa = {
    userId: user.userId,
    email: user.email,
    isGoogleAuth: options.isGoogleAuth === true,
    createdAt: new Date().toISOString()
  };
  await saveSession(req);
}

function getRequestCsrfToken(req, res) {
  if (res && res.locals && typeof res.locals.csrfToken === 'string') {
    return res.locals.csrfToken;
  }
  if (req.session && typeof req.session.csrfToken === 'string') {
    return req.session.csrfToken;
  }
  return '';
}

/**
 * GET /setup
 * Universal bootstrap installer (no authentication required)
 * Prompts user for API key, then fetches customized CLI script
 * This route is placed BEFORE CSRF protection as it's accessed via curl
 */
router.get('/setup', async (req, res) => {
  try {
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    const bootstrapScript = `#!/bin/bash
# ChatMCP Agent CLI Installer

# Cleanup on exit
TEMP_FILE="agent-cli.sh.tmp"
trap 'rm -f "$TEMP_FILE"' EXIT
GLOBAL_INSTALL_DIR="$HOME/.chatmcp"
GLOBAL_INSTALL_PATH="$GLOBAL_INSTALL_DIR/agent-cli.sh"
LOCAL_INSTALL_PATH="$(pwd)/agent-cli.sh"

install_jetspace_command() {
    local rc_file="$1"
    local marker_start="# >>> chatmcp jetspace >>>"
    local marker_end="# <<< chatmcp jetspace <<<"

    mkdir -p "$(dirname "$rc_file")"
    touch "$rc_file"

    if grep -Fq "$marker_start" "$rc_file"; then
        return 0
    fi

    cat >> "$rc_file" <<EOF

$marker_start
jetspace() {
  bash "$GLOBAL_INSTALL_PATH" "\$@"
}
$marker_end
EOF
}

# Function to detect OS and install gum automatically
install_gum() {
    echo "Installing gum..."
    echo ""
    
    # Detect OS
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command -v brew &> /dev/null; then
            echo "Detected macOS with Homebrew. Installing gum via brew..."
            brew install gum
        else
            echo "Error: Homebrew is required to install gum on macOS."
            echo "Install Homebrew first: https://brew.sh"
            exit 1
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux - detect package manager
        if command -v apt-get &> /dev/null; then
            # Debian/Ubuntu
            echo "Detected Debian/Ubuntu. Installing gum via apt..."
            sudo mkdir -p /etc/apt/keyrings
            curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/charm.gpg
            echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list
            sudo apt update && sudo apt install -y gum
        elif command -v dnf &> /dev/null; then
            # Fedora/RHEL
            echo "Detected Fedora/RHEL. Installing gum via dnf..."
            echo '[charm]
name=Charm
baseurl=https://repo.charm.sh/yum/
enabled=1
gpgcheck=1
gpgkey=https://repo.charm.sh/yum/gpg.key' | sudo tee /etc/yum.repos.d/charm.repo
            sudo dnf install -y gum
        elif command -v yum &> /dev/null; then
            # CentOS/older RHEL
            echo "Detected CentOS/RHEL. Installing gum via yum..."
            echo '[charm]
name=Charm
baseurl=https://repo.charm.sh/yum/
enabled=1
gpgcheck=1
gpgkey=https://repo.charm.sh/yum/gpg.key' | sudo tee /etc/yum.repos.d/charm.repo
            sudo yum install -y gum
        elif command -v pacman &> /dev/null; then
            # Arch Linux
            echo "Detected Arch Linux. Installing gum via pacman..."
            sudo pacman -Sy --noconfirm gum
        elif command -v zypper &> /dev/null; then
            # openSUSE
            echo "Detected openSUSE. Installing gum via zypper..."
            echo '[charm]
name=Charm
baseurl=https://repo.charm.sh/yum/
enabled=1
gpgcheck=1
gpgkey=https://repo.charm.sh/yum/gpg.key' | sudo tee /etc/zypp/repos.d/charm.repo
            sudo zypper refresh && sudo zypper install -y gum
        elif command -v apk &> /dev/null; then
            # Alpine Linux
            echo "Detected Alpine Linux. Installing gum via apk..."
            apk add --no-cache gum
        elif command -v nix-env &> /dev/null; then
            # NixOS
            echo "Detected NixOS. Installing gum via nix-env..."
            nix-env -iA nixpkgs.gum
        elif command -v brew &> /dev/null; then
            # Linux with Homebrew (Linuxbrew)
            echo "Detected Linuxbrew. Installing gum via brew..."
            brew install gum
        else
            echo "Error: Could not detect package manager to install gum."
            echo ""
            echo "Please install gum manually: https://github.com/charmbracelet/gum#installation"
            exit 1
        fi
    else
        echo "Error: Unsupported operating system: $OSTYPE"
        echo "Please install gum manually: https://github.com/charmbracelet/gum#installation"
        exit 1
    fi
    
    # Verify installation
    if ! command -v gum &> /dev/null; then
        echo ""
        echo "Error: gum installation failed. Please install manually:"
        echo "https://github.com/charmbracelet/gum#installation"
        exit 1
    fi
    
    echo ""
    echo "✓ gum installed successfully!"
    echo ""
}

# Check if gum is installed, if not install it automatically
if ! command -v gum &> /dev/null; then
    echo "gum is not installed. It's required for this installer."
    echo ""
    
    # Ask for permission to install (using basic bash since gum isn't available yet)
    read -p "Would you like to install gum automatically? [Y/n] " -n 1 -r < /dev/tty
    echo ""
    
    if [[ ! $REPLY =~ ^[Nn]$ ]]; then
        install_gum
    else
        echo "Installation cancelled. Please install gum manually:"
        echo "https://github.com/charmbracelet/gum#installation"
        exit 1
    fi
fi

# Welcome banner
gum style \\
    --border double \\
    --border-foreground 212 \\
    --padding "1 2" \\
    --margin "1 0" \\
    --align center \\
    "ChatMCP Agent CLI - Quick Setup"

# Show instructions
gum style --foreground 245 "This installer will set up the Agent CLI for managing your AI agents."
echo ""

gum style --bold "To get your API key:"
echo ""
echo "$(gum style --foreground 212 "  • New user?")      $(gum style --foreground 250 "Register at: ${baseUrl}/register")"
echo "$(gum style --foreground 212 "  • Existing user?")  $(gum style --foreground 250 "Get key from: ${baseUrl}/settings")"
echo ""

gum style --italic --foreground 245 "Your API key looks like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
echo ""

# Prompt for API key with gum (redirect from /dev/tty for curl|bash compatibility)
gum style --foreground 245 "Enter your API key below (input will be hidden for security):"
API_KEY=$(gum input --password --prompt "🔑 " < /dev/tty)

if [ -z "$API_KEY" ]; then
    echo ""
    gum style --foreground 196 "✗ Error: API key is required"
    exit 1
fi

# Trim whitespace to avoid hidden copy/paste characters
API_KEY="$(echo "$API_KEY" | tr -d '[:space:]')"

# Basic UUID format validation
if ! [[ "$API_KEY" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    echo ""
    gum style --foreground 196 "✗ Error: Invalid API key format"
    gum style --foreground 245 "API key should be in UUID format (e.g., xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)"
    exit 1
fi

echo ""
gum style --foreground 46 "✓ API key validated"
echo ""

# Fetch customized script with spinner. Body, headers and HTTP code are captured
# to separate files so an optional integrity checksum can be verified against the
# RAW downloaded bytes (before any shell reconstruction that could alter them).
CLI_BODY_FILE="/tmp/cli_body_$$.sh"
CLI_HDR_FILE="/tmp/cli_hdr_$$.txt"
CLI_CODE_FILE="/tmp/cli_code_$$.txt"
gum spin --spinner dot --title "Fetching your customized CLI script..." -- \\
    bash -c "curl -sL -H 'X-API-Key: $API_KEY' -D '$CLI_HDR_FILE' -o '$CLI_BODY_FILE' -w '%{http_code}' '${baseUrl}/api/agent/cli-script' > '$CLI_CODE_FILE' 2>/dev/null"

if [ ! -f "$CLI_BODY_FILE" ] || [ ! -f "$CLI_CODE_FILE" ]; then
    echo ""
    gum style --foreground 196 "✗ Error: Failed to fetch script (network error)"
    rm -f "$CLI_BODY_FILE" "$CLI_HDR_FILE" "$CLI_CODE_FILE"
    exit 1
fi

HTTP_CODE=$(cat "$CLI_CODE_FILE")
rm -f "$CLI_CODE_FILE"
SCRIPT=$(cat "$CLI_BODY_FILE")

# Check for errors
if [ "$HTTP_CODE" != "200" ]; then
    echo ""
    gum style --foreground 196 "✗ Error: Failed to fetch script (HTTP $HTTP_CODE)"
    if [ "$HTTP_CODE" == "401" ]; then
        gum style --foreground 245 "Invalid API key. Please check your key and try again."
        gum style --foreground 245 "Get your key at: ${baseUrl}/settings"
    elif [ "$HTTP_CODE" == "500" ]; then
        gum style --foreground 245 "Server error. Please try again later or contact support."
    else
        gum style --foreground 245 "Unexpected error. Please try again."
    fi
    rm -f "$CLI_BODY_FILE" "$CLI_HDR_FILE"
    exit 1
fi

echo ""
gum style --foreground 46 "✓ Script fetched successfully"

# Optional integrity check. If the server advertised an X-Script-SHA256 header,
# verify the downloaded bytes match it. This is backward-compatible: older
# servers omit the header, so we skip verification (with a note) rather than
# failing the install. It catches truncated/corrupted/tampered downloads in
# transit — it is NOT a defense against a malicious operator (who controls both
# the script and the checksum).
EXPECTED_SHA=$(grep -i '^x-script-sha256:' "$CLI_HDR_FILE" 2>/dev/null | tail -n1 | tr -d '\\r' | awk '{print $2}')
if [ -n "$EXPECTED_SHA" ]; then
    if command -v openssl >/dev/null 2>&1; then
        ACTUAL_SHA=$(openssl dgst -sha256 "$CLI_BODY_FILE" 2>/dev/null | awk '{print $NF}')
        if [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ]; then
            gum style --foreground 46 "✓ Script integrity verified (SHA-256)"
        else
            echo ""
            gum style --foreground 196 "✗ Error: Script integrity check FAILED"
            gum style --foreground 245 "Expected: $EXPECTED_SHA"
            gum style --foreground 245 "Actual:   $ACTUAL_SHA"
            gum style --foreground 245 "The download may be corrupted or tampered with. Aborting install."
            rm -f "$CLI_BODY_FILE" "$CLI_HDR_FILE"
            exit 1
        fi
    else
        gum style --foreground 214 "⚠️  openssl not found — skipping integrity verification"
    fi
fi

# Optional preview (default to No for faster installation)
if gum confirm "Preview script before saving?" --default=false < /dev/tty; then
    echo ""
    gum style --border normal --border-foreground 212 --padding "0 1" "First 20 lines of script:"
    echo "$SCRIPT" | head -20 | gum style --foreground 250
    echo ""

    if ! gum confirm "Continue with installation?" --default=true < /dev/tty; then
        gum style --foreground 245 "Installation cancelled."
        rm -f "$CLI_BODY_FILE" "$CLI_HDR_FILE"
        exit 0
    fi
    echo ""
fi

# Save the verified script bytes directly (preserves exact server output).
mv "$CLI_BODY_FILE" "$LOCAL_INSTALL_PATH"
rm -f "$CLI_HDR_FILE"
chmod +x "$LOCAL_INSTALL_PATH"

# Save reusable global copy for shell command usage
mkdir -p "$GLOBAL_INSTALL_DIR"
cp "$LOCAL_INSTALL_PATH" "$GLOBAL_INSTALL_PATH"
chmod +x "$GLOBAL_INSTALL_PATH"

gum style --foreground 46 "✓ Saved to: $LOCAL_INSTALL_PATH"
gum style --foreground 46 "✓ Global launcher saved to: $GLOBAL_INSTALL_PATH"
echo ""

JETSPACE_INSTALLED=false
JETSPACE_TARGETS=""
if gum confirm "Install the 'jetspace' shell command for quick agent setup in any folder?" --default=true < /dev/tty; then
    install_jetspace_command "$HOME/.bashrc"
    JETSPACE_TARGETS="$HOME/.bashrc"

    if [ "$(basename "\${SHELL:-}")" = "zsh" ] || [ -f "$HOME/.zshrc" ]; then
        install_jetspace_command "$HOME/.zshrc"
        JETSPACE_TARGETS="$JETSPACE_TARGETS $HOME/.zshrc"
    fi

    JETSPACE_INSTALLED=true
    gum style --foreground 46 "✓ Installed jetspace shell command"
    echo ""
fi

gum style \\
    --border double \\
    --border-foreground 46 \\
    --padding "1 2" \\
    --margin "1 0" \\
    --align center \\
    "✓ Setup Complete!"

echo ""
gum style --bold "Your CLI script has been saved to:"
gum style --foreground 212 "  $LOCAL_INSTALL_PATH"
gum style --foreground 212 "  $GLOBAL_INSTALL_PATH"
echo ""

gum style --bold "To get started, run:"
gum style --foreground 212 "  bash agent-cli.sh"
if [ "$JETSPACE_INSTALLED" = "true" ]; then
    echo ""
    gum style --bold "After opening a new shell, you can run from any project folder:"
    gum style --foreground 212 "  jetspace"
    gum style --foreground 245 "Shell config updated:$JETSPACE_TARGETS"
fi
echo ""
`;

    // Serve as shell script
    res.type('text/plain').send(bootstrapScript);
  } catch (error) {
    console.error('Bootstrap script error:', error);
    res.status(500).type('text/plain').send('Internal server error');
  }
});

// Apply CSRF protection to all page routes
router.use(csrfProtection);

/**
 * GET /csrf-token
 * Returns a fresh CSRF token (auto-refreshed by csrfProtection middleware)
 */
router.get('/csrf-token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ csrfToken: req.session.csrfToken });
});

/**
 * GET /
 * Root route - show landing page or redirect to dashboard
 */
router.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect(postLoginRedirectUrl(req));
  }
  return renderLandingPage(req, res);
});

/**
 * GET /demo
 * Demo page with hardcoded agents
 */
router.get('/demo', (req, res) => {
  const agents = [
    {
       agentId: 'demo-1',
       agentName: 'Nexus',
       name: 'Nexus',
       agentType: 'standard',
       position: 1,
       lastMessageId: 'msg-1',
       lastMessageTime: new Date().toISOString(),
       lastActivityTime: new Date().toISOString(),
       unreadCount: 2,
       highestPriority: 'high',
       lastMessagePriority: 'high',
       marbleSvg: MarbleGenerator.generateMarble('demo-1', 100, 'Nexus', 'ssr')
    },
    {
       agentId: 'demo-2',
       agentName: 'Echo',
       name: 'Echo',
       agentType: 'standard',
       position: 2,
       lastMessageId: 'msg-2',
       lastMessageTime: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
       lastActivityTime: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
       unreadCount: 1,
       highestPriority: 'normal',
       lastMessagePriority: 'normal',
       marbleSvg: MarbleGenerator.generateMarble('demo-2', 100, 'Echo', 'ssr')
    },
     {
       agentId: 'demo-3',
       agentName: 'Sage',
       name: 'Sage',
       agentType: 'standard',
       position: 3,
       lastMessageId: 'msg-3',
       lastMessageTime: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
       lastActivityTime: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
       unreadCount: 0,
       highestPriority: 'low',
       lastMessagePriority: 'low',
       marbleSvg: MarbleGenerator.generateMarble('demo-3', 100, 'Sage', 'ssr')
    }
  ];

  res.render('demo', {
    user: { email: 'demo@example.com' },
    agents: agents,
    encryptionSalt: 'demo-salt',
    isGoogleAuth: false,
    showSetupShortcut: false,
    csrfToken: getRequestCsrfToken(req, res),
    agentsJSON: toInlineScriptJSON(agents),
    demoScenarioJSON: toInlineScriptJSON({
      focusedAgentId: 'demo-1',
      messagesByAgent: {}
    }),
    embeddedPreview: false
  });
});

/**
 * GET /dashboard-preview
 * Embed-friendly dashboard preview for the landing page
 */
router.get('/dashboard-preview', (req, res) => {
  const previewModel = buildLandingDashboardPreviewModel();

  res.render('demo', {
    user: null,
    agents: previewModel.agents,
    encryptionSalt: 'preview-salt',
    isGoogleAuth: false,
    showSetupShortcut: false,
    csrfToken: getRequestCsrfToken(req, res),
    agentsJSON: toInlineScriptJSON(previewModel.agents),
    demoScenarioJSON: toInlineScriptJSON({
      focusedAgentId: previewModel.focusedAgentId,
      messagesByAgent: previewModel.messagesByAgent
    }),
    agentTheme: previewModel.agentTheme,
    embeddedPreview: true
  });
});

/**
 * GET /auth/google
 * Initiate Google OAuth authentication
 */
router.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  // Always show Google's account chooser so users can switch accounts
  prompt: 'select_account'
}));

/**
 * GET /auth/google/callback
 * Handle Google OAuth callback
 */
router.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/', session: false }),
  async (req, res) => {
    try {
      if (await isUserMfaEnabled(req.user.userId)) {
        await beginMfaChallenge(req, req.user, { isGoogleAuth: true });
        return res.redirect('/login/2fa');
      }

      await createSession(req, req.user);
      req.session.emailVerified = true;
      req.session.isGoogleAuth = true;  // Track OAuth login for encryption prompt
      res.redirect(postLoginRedirectUrl(req));
    } catch (error) {
      console.error('Google OAuth callback error:', error);
      res.redirect('/');
    }
  }
);

/**
 * GET /terms
 * Public Terms of Use page
 */
router.get('/terms', (req, res) => {
  res.render('terms');
});

/**
 * GET /privacy
 * Public Privacy Policy page
 */
router.get('/privacy', (req, res) => {
  res.render('privacy');
});

/**
 * GET /architecture
 * Public architecture and extension guide
 */
router.get('/architecture', (req, res) => {
  res.render('architecture-guide', {
    title: 'ChatMCPSpace Architecture Guide'
  });
});

/**
 * GET /register
 * Render registration page
 */
router.get('/join/invitation/:invitationId', (req, res) => {
  const invitationId = req.params.invitationId;
  if (!SHARING_INVITATION_ID_RE.test(invitationId)) return res.redirect('/register');
  if (req.session) req.session.pendingSharingInvitationId = invitationId;
  if (req.session?.userId) return res.redirect(dashboardInvitationUrl(req));
  return res.redirect('/register');
});

router.get('/register', (req, res) => {
  const invitationId = typeof req.query.invitationId === 'string' && SHARING_INVITATION_ID_RE.test(req.query.invitationId)
    ? req.query.invitationId : getPendingSharingInvitationId(req);
  if (invitationId && req.session) req.session.pendingSharingInvitationId = invitationId;
  // If already logged in, redirect to dashboard
  if (req.session && req.session.userId) {
    return res.redirect(dashboardInvitationUrl(req));
  }

  res.render('register', {
    error: null,
    email: '',
    invitationId
  });
});

/**
 * POST /register
 * Handle user registration
 */
router.post('/register', authRateLimiter, validateCsrfToken, async (req, res) => {
  try {
    const { email, password, confirmPassword } = req.body;
    const submittedInvitationId = typeof req.body.invitationId === 'string' && SHARING_INVITATION_ID_RE.test(req.body.invitationId)
      ? req.body.invitationId : null;
    if (submittedInvitationId && req.session) req.session.pendingSharingInvitationId = submittedInvitationId;

    // Validate input
    if (!email || !password) {
      return res.render('register', {
        error: 'Email and password are required',
        email: email || '', invitationId: getPendingSharingInvitationId(req)
      });
    }

    // Validate email format
    if (!isValidEmail(email)) {
      return res.render('register', {
        error: 'Please enter a valid email address',
        email: email, invitationId: getPendingSharingInvitationId(req)
      });
    }

    // Validate password strength
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.render('register', {
        error: passwordValidation.message,
        email: email, invitationId: getPendingSharingInvitationId(req)
      });
    }

    // Validate password confirmation
    if (password !== confirmPassword) {
      return res.render('register', {
        error: 'Passwords do not match',
        email: email
      });
    }

    // Register user
    const user = await registerUser(email, password);

    // Local mode: there is no verification email to wait on, so log the new
    // user in straight away.
    if (isLocalAuthMode()) {
      await createSession(req, user);
      return res.redirect(dashboardInvitationUrl(req));
    }

    // Send verification email
    const emailResult = await sendVerificationEmail(user.userId, email, {
      ip: req.ip,
      userAgent: req.get('user-agent')
    });

    // Store email temporarily in session for the verify-email-sent page
    // But do NOT log the user in - they must verify email first
    req.session.pendingVerificationEmail = email;
    delete req.session.verificationSendError;

    if (!emailResult.success) {
      req.session.verificationSendError = emailResult.error || 'We could not send the verification code. Please try resending it.';
    }

    // Redirect to verification pending page
    res.redirect('/verify-email-sent');

  } catch (error) {
    console.error('Registration error:', error);

    let errorMessage = 'Registration failed. Please try again.';
    if (error.message === 'Email already registered') {
      errorMessage = 'This email is already registered. Please login instead.';
    }

    res.render('register', {
      error: errorMessage,
      email: req.body.email || '', invitationId: getPendingSharingInvitationId(req)
    });
  }
});

/**
 * GET /verify-email-sent
 * Show verification email sent confirmation page
 */
router.get('/verify-email-sent', (req, res) => {
  // Get the pending verification email (set during registration)
  const email = req.session?.pendingVerificationEmail || null;
  const sendError = req.session?.verificationSendError || null;

  // If no pending email and user is not logged in, redirect to home
  if (!email && !req.session?.userId) {
    return res.redirect('/');
  }

  if (req.session?.verificationSendError) {
    delete req.session.verificationSendError;
  }

  res.render('verify-email-sent', {
    email: email || req.session?.email || null,
    sendError,
    invitationId: getPendingSharingInvitationId(req)
  });
});

/**
 * GET /verify-email
 * Handle email verification link
 */
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.render('verify-email-result', {
        success: false,
        error: 'Verification token is missing',
        alreadyVerified: false
      });
    }

    // Verify the token
    const result = await verifyEmailToken(token);

    if (!result.success) {
      return res.render('verify-email-result', {
        success: false,
        error: result.error,
        alreadyVerified: false
      });
    }

    // Clear the pending verification email from session
    if (req.session?.pendingVerificationEmail) {
      delete req.session.pendingVerificationEmail;
    }

    // If user is not logged in, log them in now that email is verified
    if (!req.session?.userId && result.userId) {
      // Get full user data for session
      const userResult = await query(
        'SELECT user_id, email, api_key FROM users WHERE user_id = $1',
        [result.userId]
      );

      if (userResult.rows.length > 0) {
        const user = {
          userId: userResult.rows[0].user_id,
          email: userResult.rows[0].email,
          apiKey: userResult.rows[0].api_key
        };
        await createSession(req, user);
        req.session.emailVerified = true;
      }
    } else if (req.session?.userId === result.userId) {
      // User is already logged in and this is their email
      req.session.emailVerified = true;
    }

    res.render('verify-email-result', {
      success: true,
      email: result.email,
      alreadyVerified: result.alreadyVerified || false
    });

  } catch (error) {
    console.error('Email verification error:', error);
    res.render('verify-email-result', {
      success: false,
      error: 'An error occurred during verification. Please try again.',
      alreadyVerified: false
    });
  }
});

/**
 * POST /resend-verification
 * Resend verification email
 */
router.post('/resend-verification', authRateLimiter, validateCsrfToken, async (req, res) => {
  try {
    const email = req.body.email || req.session?.email;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email address is required'
      });
    }

    const result = await resendVerificationEmail(email, {
      ip: req.ip,
      userAgent: req.get('user-agent')
    });

    if (result.rateLimited) {
      return res.status(429).json({
        success: false,
        error: result.error
      });
    }

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Verification email sent successfully'
    });

  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resend verification email'
    });
  }
});

/**
 * POST /verify-code
 * Verify email with 6-digit code
 */
router.post('/verify-code', authRateLimiter, validateCsrfToken, async (req, res) => {
  try {
    let { email, code, _csrf } = req.body;

    // Trim whitespace to handle copy-paste errors
    email = email?.trim();
    code = code?.trim();

    if (!email || !code) {
      return res.status(400).json({
        success: false,
        error: 'Email and verification code are required'
      });
    }

    // Verify the code
    const result = await verifyEmailCode(email, code);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    // Clear the pending verification email from session
    if (req.session?.pendingVerificationEmail) {
      delete req.session.pendingVerificationEmail;
    }

    // Log the user in now that email is verified
    const userResult = await query(
      'SELECT user_id, email, api_key FROM users WHERE user_id = $1',
      [result.userId]
    );

    if (userResult.rows.length > 0) {
      const user = {
        userId: userResult.rows[0].user_id,
        email: userResult.rows[0].email,
        apiKey: userResult.rows[0].api_key
      };
      await createSession(req, user);
      req.session.emailVerified = true;
    }

    res.json({
      success: true,
      message: result.alreadyVerified ? 'Email was already verified' : 'Email verified successfully',
      alreadyVerified: result.alreadyVerified || false,
      redirectTo: dashboardInvitationUrl(req)
    });

  } catch (error) {
    console.error('Code verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify code'
    });
  }
});

/**
 * GET /login
 * Redirect to landing page (which has the login form)
 */
router.get('/login', (req, res) => {
  // If already logged in, redirect to dashboard
  if (req.session && req.session.userId) {
    return res.redirect(postLoginRedirectUrl(req));
  }

  // Redirect to landing page which has the login form
  res.redirect('/');
});

/**
 * GET /login/2fa
 * Render the MFA challenge step for pending logins
 */
router.get('/login/2fa', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect(postLoginRedirectUrl(req));
  }

  const pendingMfa = getValidPendingMfa(req);
  if (!pendingMfa) {
    return res.redirect('/');
  }

  return renderLandingPage(req, res, {
    email: pendingMfa.email,
    mfaChallenge: {
      email: pendingMfa.email
    }
  });
});

/**
 * POST /login
 * Handle user authentication
 */
router.post('/login', authRateLimiter, validateCsrfToken, async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return renderLandingPage(req, res, {
        error: 'Email and password are required',
        email: email || ''
      });
    }

    // Validate credentials
    const user = await validateCredentials(email, password);

    if (!user) {
      // Log authentication failure
      logAuthenticationFailure(req, email, 'Invalid credentials');

      return renderLandingPage(req, res, {
        error: 'Invalid email or password',
        email: email
      });
    }

    // Check if email is not verified
    if (user.emailNotVerified) {
      // Store email in session for the verify-email-sent page
      req.session.pendingVerificationEmail = user.email;

      return renderLandingPage(req, res, {
        error: 'Please verify your email before logging in. Check your inbox for the verification link.',
        email: email
      });
    }

    if (await isUserMfaEnabled(user.userId)) {
      await beginMfaChallenge(req, user, { isGoogleAuth: false });
      if (req.get('Accept')?.includes('application/json')) {
        return res.json({ redirectTo: '/login/2fa' });
      }
      return res.redirect('/login/2fa');
    }

    await createSession(req, user);

    // Fetch cannot read a manual redirect's Location header in a browser.
    // Return the server-selected continuation explicitly to the sign-in form.
    const redirectTo = postLoginRedirectUrl(req);
    if (req.get('Accept')?.includes('application/json')) {
      return res.json({ redirectTo });
    }
    res.redirect(redirectTo);

  } catch (error) {
    console.error('Login error:', error);
    renderLandingPage(req, res, {
      error: 'Login failed. Please try again.',
      email: req.body.email || ''
    });
  }
});

/**
 * GET /logout
 * Destroy session and redirect to landing page
 */
router.get('/logout', async (req, res) => {
  try {
    await destroySession(req);
    res.redirect('/');
  } catch (error) {
    console.error('Logout error:', error);
    res.redirect('/');
  }
});

/**
 * GET /dashboard
 * Render dashboard page with agent list
 * Requires authentication
 */
const UUID_ROUTE_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function legacyShareConversationId(queryParams) {
  for (const name of ['conversationId', 'roomId', 'id']) {
    const candidate = queryParams?.[name];
    if (typeof candidate === 'string' && UUID_ROUTE_PARAM.test(candidate)) return candidate;
  }
  return null;
}

async function dashboardShareRedirect(req, res) {
  const threadService = require('../shared/chatThreadService');
  const conversationId = legacyShareConversationId(req.query);
  if (conversationId) {
    try {
      await threadService.getChatContext(req.user.userId, conversationId);
      return res.redirect(302, '/dashboard?conversationId=' + encodeURIComponent(conversationId));
    } catch (_) {
      // A stale or inaccessible legacy room must not prevent agent-based
      // resolution when the old link also carries an agentId.
    }
  }

  const agentId = req.query?.agentId;
  if (typeof agentId === 'string' && UUID_ROUTE_PARAM.test(agentId)) {
    const owned = (await query('SELECT agent_id FROM agents WHERE agent_id=$1 AND user_id=$2', [agentId, req.user.userId])).rows[0];
    if (owned) {
      try {
        const thread = await threadService.resolveAgentThread(req.user.userId, agentId);
        return res.redirect(302, '/dashboard?conversationId=' + encodeURIComponent(thread.conversationId));
      } catch (_) {
        // Fall through to the dashboard if a stale agent link cannot resolve.
      }
    }
    try {
      const threads = await threadService.listChatThreads(req.user.userId);
      const accessible = threads.find(thread => thread.agentId === agentId &&
        (thread.role === 'owner' || thread.membershipStatus === 'active'));
      if (accessible) return res.redirect(302, '/dashboard?conversationId=' + encodeURIComponent(accessible.conversationId));
    } catch (_) {
      // A valid agent may have no existing conversation for this account.
    }
  }

  return res.redirect(302, '/dashboard');
}

router.get('/shared', protectRoute, async (req, res) => {
  if (process.env.FEATURE_IN_PLACE_AGENT_SHARING === 'true') return dashboardShareRedirect(req, res);
  if (process.env.FEATURE_SHARED_CONVERSATIONS !== 'true') return res.status(404).send('Not found');
  res.render('shared', { title: 'Shared conversations', pageBodyClass: 'shared-page', csrfToken: res.locals.csrfToken });
});

router.get('/guest-sharing', protectRoute, async (req, res) => {
  if (process.env.FEATURE_IN_PLACE_AGENT_SHARING === 'true') return dashboardShareRedirect(req, res);
  if (process.env.FEATURE_SHARED_CONVERSATIONS !== 'true' || process.env.FEATURE_GUEST_SHARING !== 'true') {
    return res.status(404).send('Not found');
  }
  res.render('guest-sharing', {
    title: 'Guest sharing',
    pageBodyClass: 'guest-sharing-page',
    csrfToken: res.locals.csrfToken,
    userId: req.user.userId
  });
});

router.get('/dashboard', protectRoute, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Fetch encryption salt so the browser can derive the decryption key
    const saltResult = await query(
      'SELECT api_key, encryption_salt FROM users WHERE user_id = $1',
      [userId]
    );

    const apiKey = saltResult.rows.length > 0
      ? saltResult.rows[0].api_key
      : null;

    let encryptionSalt = saltResult.rows.length > 0
      ? saltResult.rows[0].encryption_salt
      : null;

    // Generate encryption_salt if missing (legacy user)
    if (!encryptionSalt) {
      encryptionSalt = generateEncryptionSalt();
      await query('UPDATE users SET encryption_salt = $1 WHERE user_id = $2', [encryptionSalt, userId]);
      console.log(`Dashboard: Generated encryption_salt for legacy user ID: ${userId}`);
    }

    // Fetch agent list with metadata
    const agentsResult = await query(`
      SELECT 
        a.agent_id,
        a.agent_name,
        a.agent_type,
        a.position,
        a.last_seen_at,
        a.is_working,
        a.last_working_heartbeat_at,
        MAX(m.created_at) as last_message_time,
        COUNT(CASE WHEN m.message_type = 'question' AND ur.response_id IS NULL THEN 1 END) as unread_count,
        MAX(CASE 
          WHEN m.message_type = 'question' AND ur.response_id IS NULL AND m.priority = 2 THEN 3 
          WHEN m.message_type = 'question' AND ur.response_id IS NULL AND m.priority = 1 THEN 2 
          WHEN m.message_type = 'question' AND ur.response_id IS NULL THEN 1 
          ELSE 0 
        END) as priority_value,
        (SELECT message_id FROM messages m_last WHERE m_last.agent_id = a.agent_id ORDER BY m_last.created_at DESC LIMIT 1) as last_message_id,
        (SELECT priority FROM messages m2 WHERE m2.agent_id = a.agent_id ORDER BY m2.created_at DESC LIMIT 1) as last_message_priority
      FROM agents a
      LEFT JOIN messages m ON a.agent_id = m.agent_id
      LEFT JOIN user_responses ur ON m.message_id = ur.message_id

      WHERE a.user_id = $1
      GROUP BY a.agent_id, a.agent_name, a.agent_type, a.position, a.last_seen_at, a.is_working, a.last_working_heartbeat_at
      ORDER BY a.position ASC
    `, [userId]);

    // Format agent data
    const MarbleGenerator = require('../../public/js/marble-generator');

    const agents = agentsResult.rows.map(row => {
      // Use last_seen_at (when agent sent message or checked for updates) as the primary activity indicator
      const lastActivityTime = row.last_seen_at || row.last_message_time;
      const lastWorkingHeartbeatTime = row.last_working_heartbeat_at;
      const workingHeartbeatAgeMs = lastWorkingHeartbeatTime
        ? (Date.now() - new Date(lastWorkingHeartbeatTime).getTime())
        : Number.POSITIVE_INFINITY;
      const isWorking = row.is_working === true && workingHeartbeatAgeMs <= 30000;
      const lastMessageTime = row.last_message_time;
      const lastMessageId = row.last_message_id;
      return {
        agentId: row.agent_id,
        name: row.agent_name,
        agentType: row.agent_type || 'standard',
        position: row.position,
        isWorking,
        lastWorkingHeartbeatTime: lastWorkingHeartbeatTime ? lastWorkingHeartbeatTime.toISOString() : null,
        lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
        lastMessageId: lastMessageId || null,
        lastMessageTime: lastMessageTime ? lastMessageTime.toISOString() : null,
        lastActivityTime: lastActivityTime ? lastActivityTime.toISOString() : null,
        unreadCount: parseInt(row.unread_count) || 0,
        highestPriority: row.priority_value === 3 ? 'high' : row.priority_value === 2 ? 'normal' : 'low',
        lastMessagePriority: row.last_message_priority === 2 ? 'high' : row.last_message_priority === 1 ? 'normal' : 'low',
        marbleSvg: MarbleGenerator.generateMarble(row.agent_id, 100, row.agent_name, 'ssr')
      };
    });

    // Fetch groups for initial render
    const groupsResult = await query(`
      SELECT g.group_id, g.group_name, g.description,
             COALESCE(json_agg(gm.agent_id) FILTER (WHERE gm.agent_id IS NOT NULL), '[]') as member_ids
      FROM agent_groups g
      LEFT JOIN agent_group_members gm ON g.group_id = gm.group_id
      WHERE g.user_id = $1
      GROUP BY g.group_id, g.group_name, g.description
      ORDER BY g.created_at ASC
    `, [userId]);

    const groups = groupsResult.rows.map(r => ({
      groupId: r.group_id,
      groupName: r.group_name,
      description: r.description || '',
      memberIds: r.member_ids || []
    }));

    res.render('dashboard', {
      user: req.user,
      agents: agents,
      groups: groups,
      apiKey,
      encryptionSalt,
      isGoogleAuth: req.session.isGoogleAuth || false,
      showSetupShortcut: true
    });

  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).render('error', {
      statusCode: 500,
      error: 'Failed to load dashboard'
    });
  }
});

/**
 * POST /settings/generate-guide
 * Generate API guide dynamically (AJAX endpoint)
 */
router.post('/settings/generate-guide', protectRoute, async (req, res) => {
  try {
    const { agentName, variant } = req.body;

    // Get user's API key and encryption salt
    const userResult = await query(
      'SELECT api_key, encryption_salt FROM users WHERE user_id = $1',
      [req.user.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const apiKey = userResult.rows[0].api_key;
    const encryptionSalt = userResult.rows[0].encryption_salt;
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const sanitizedAgentName = (agentName || 'CLI-Test-Agent').trim().slice(0, 255);

    // Generate the appropriate guide
    let guide;
    if (variant === 'main' || variant === 'cli') {
      guide = generateMainCLIScript(apiKey, baseUrl, encryptionSalt);
    } else if (variant === 'direct' || variant === 'setup') {
      guide = generateDirectSetupScript(apiKey, baseUrl, sanitizedAgentName, encryptionSalt);
    } else {
      guide = generateApiGuide(apiKey, baseUrl, sanitizedAgentName, encryptionSalt);
    }

    res.json({ guide });
  } catch (error) {
    console.error('Generate guide error:', error);
    res.status(500).json({ error: 'Failed to generate guide' });
  }
});

/**
 * POST /login/2fa
 * Complete a pending MFA challenge and create the authenticated session
 */
router.post('/login/2fa', authRateLimiter, validateCsrfToken, async (req, res) => {
  try {
    const pendingMfa = getValidPendingMfa(req);
    if (!pendingMfa) {
      return renderLandingPage(req, res, {
        error: 'Your sign-in session expired. Please try again.',
        mfaChallenge: null
      });
    }

    const { code } = req.body;
    const valid = await verifyUserMfaCode(pendingMfa.userId, code);

    if (!valid) {
      return renderLandingPage(req, res, {
        email: pendingMfa.email,
        error: 'Invalid authenticator or recovery code. Please try again.',
        mfaChallenge: {
          email: pendingMfa.email
        }
      });
    }

    clearPendingMfa(req);
    req.session.emailVerified = true;
    req.session.isGoogleAuth = pendingMfa.isGoogleAuth === true;
    await createSession(req, {
      userId: pendingMfa.userId,
      email: pendingMfa.email
    });

    return res.redirect(postLoginRedirectUrl(req));
  } catch (error) {
    console.error('2FA login error:', error);
    const pendingMfa = getValidPendingMfa(req);
    return renderLandingPage(req, res, {
      email: pendingMfa?.email || '',
      error: 'Two-factor authentication failed. Please try again.',
      mfaChallenge: pendingMfa ? { email: pendingMfa.email } : null
    });
  }
});

/**
 * GET /settings/external-agents/approve
 * Authenticated approval page for agent-started external setup.
 */
router.get('/settings/external-agents/approve', protectRoute, async (req, res) => {
  const provider = String(req.query.provider || 'custom').trim().toLowerCase();
  const agentName = String(req.query.agentName || req.query.agent || 'External Agent').trim().slice(0, 255);
  const providerBotRef = String(req.query.providerBotRef || '').trim().slice(0, 255);

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Approve External Agent</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101820; color: #f6f7fb; }
    main { width: min(560px, calc(100vw - 32px)); border: 1px solid #2f4050; border-radius: 8px; padding: 24px; background: #17222c; box-shadow: 0 18px 60px rgba(0,0,0,.35); }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { color: #cbd5e1; line-height: 1.5; }
    button { border: 0; border-radius: 6px; padding: 12px 16px; background: #36c2ff; color: #07131d; font-weight: 700; cursor: pointer; }
    button:disabled { opacity: .65; cursor: wait; }
    code { display: inline-block; padding: 8px 10px; border-radius: 6px; background: #0b1118; color: #93e6ff; font-size: 20px; letter-spacing: .08em; }
    .muted { font-size: 14px; color: #94a3b8; }
    .error { color: #fecaca; }
  </style>
</head>
<body>
  <main>
    <h1>Approve External Agent</h1>
    <p><strong>${escapeHtml(agentName)}</strong> is asking to connect to your Chat Space as a scoped external agent.</p>
    <p class="muted">Provider: ${escapeHtml(provider)}. This creates a 10-minute, single-use pairing code. Do not share your full API key.</p>
    <p>Your agent keeps running on its own machine. You can message it here and receive its replies in the same chat.</p>
    <label for="collaborationMode">Who may it collaborate with?</label>
    <select id="collaborationMode">
      <option value="disabled">Only me</option>
      <option value="groups" selected>Selected groups and agents open to collaboration</option>
      <option value="listen_all">All collaboration-enabled agents in my account</option>
    </select>
    <p><label for="collaborationGroups">Group names, separated by commas</label><br>
      <input id="collaborationGroups" type="text" placeholder="For example: My project"></p>
    <p class="muted">To receive assignments from your central agent, include its group or choose all collaboration-enabled agents. This allows messages, not remote machine administration. Creating new agents is disabled for this connection.</p>
    <p><a href="/api/agent/external-bridge-guide">Connector setup guide</a> · <a href="/api/agent/external-bridge.js">Download connector</a></p>
    <button id="approveButton" type="button">Approve and create code</button>
    <p id="result" aria-live="polite"></p>
  </main>
  <script>
    const approveButton = document.getElementById('approveButton');
    const result = document.getElementById('result');
    approveButton.addEventListener('click', async () => {
      approveButton.disabled = true;
      result.textContent = 'Creating pairing code...';
      try {
        const response = await fetch('/api/user/external-agents/pairing-codes', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': ${safeJsonForScript(res.locals.csrfToken || '')}
          },
          body: JSON.stringify({
            provider: ${safeJsonForScript(provider)},
            agentName: ${safeJsonForScript(agentName)},
            providerBotRef: ${safeJsonForScript(providerBotRef)},
            interAgentMode: document.getElementById('collaborationMode').value,
            groupNames: document.getElementById('collaborationGroups').value.split(',').map(value => value.trim()).filter(Boolean),
            canSpawn: false
          })
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload && payload.error && payload.error.message ? payload.error.message : 'Could not create pairing code');
        }
        result.innerHTML = 'Give this code to the external agent:<br><code>' + payload.pairingCode + '</code><br><span class="muted">It expires at ' + new Date(payload.expiresAt).toLocaleTimeString() + '.</span>';
      } catch (error) {
        result.className = 'error';
        result.textContent = error.message || 'Could not create pairing code';
        approveButton.disabled = false;
      }
    });
  </script>
</body>
</html>`);
});

/**
 * GET /settings
 * Render settings page with API key and guide
 * Requires authentication
 */
router.get('/settings', protectRoute, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Fetch user's API key and encryption salt
    let userResult = await query(
      'SELECT api_key, encryption_salt FROM users WHERE user_id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).render('error', {
        statusCode: 404,
        error: 'User not found'
      });
    }

    const apiKey = userResult.rows[0].api_key;
    let encryptionSalt = userResult.rows[0].encryption_salt;

    // Generate encryption_salt if missing (legacy user)
    if (!encryptionSalt) {
      encryptionSalt = generateEncryptionSalt();
      await query('UPDATE users SET encryption_salt = $1 WHERE user_id = $2', [encryptionSalt, userId]);
      console.log(`Settings: Generated encryption_salt for legacy user: ${req.user.email}`);
    }

    const defaultAgentName = 'CLI-Test-Agent';
    const userMfa = await getUserMfaRecord(userId);

    // Generate base URL (use environment variable or construct from request)
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    // Generate agent instructions and setup script with encryption support
    const apiGuideFull = generateApiGuide(apiKey, baseUrl, defaultAgentName, encryptionSalt);
    const directSetupScript = generateDirectSetupScript(apiKey, baseUrl, defaultAgentName, encryptionSalt);

    res.render('settings', {
      user: req.user,
      apiKey: apiKey,
      apiGuideFull,
      directSetupScript,
      baseUrl: baseUrl,
      defaultAgentName,
      encryptionSalt: encryptionSalt,
      mfaEnabled: userMfa?.enabled === true,
      csrfToken: res.locals.csrfToken,
      success: req.query.success === 'true' ? 'API key regenerated successfully' : null
    });

  } catch (error) {
    console.error('Settings error:', error);
    res.status(500).render('error', {
      statusCode: 500,
      error: 'Failed to load settings'
    });
  }
});

/**
 * POST /settings/2fa/setup
 * Start TOTP setup and store the pending secret in session until confirmed
 */
router.post('/settings/2fa/setup', protectRoute, validateCsrfToken, async (req, res) => {
  try {
    const secret = generateTotpSecret();
    req.session.pendingMfaSetup = {
      secret,
      createdAt: new Date().toISOString()
    };
    await saveSession(req);

    return res.json({
      success: true,
      secret,
      otpauthUrl: buildOtpAuthUrl({
        email: req.user.email,
        secret
      })
    });
  } catch (error) {
    console.error('2FA setup error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to start two-factor setup'
    });
  }
});

/**
 * POST /settings/2fa/enable
 * Verify the initial TOTP code and enable MFA for the account
 */
router.post('/settings/2fa/enable', protectRoute, validateCsrfToken, async (req, res) => {
  try {
    const pendingSetup = req.session?.pendingMfaSetup;
    const secret = pendingSetup?.secret;
    const { code } = req.body;

    if (!secret || isPendingMfaExpired(pendingSetup?.createdAt)) {
      clearPendingMfaSetup(req);
      return res.status(400).json({
        success: false,
        error: 'Two-factor setup expired. Start setup again.'
      });
    }

    if (!verifyTotpToken(secret, code)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid authentication code. Check the code and try again.'
      });
    }

    const recoveryCodes = await enableUserTotp(req.user.userId, secret);
    clearPendingMfaSetup(req);

    return res.json({
      success: true,
      message: 'Two-factor authentication is now enabled.',
      recoveryCodes
    });
  } catch (error) {
    console.error('2FA enable error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to enable two-factor authentication'
    });
  }
});

/**
 * POST /settings/2fa/disable
 * Disable MFA after verifying a current authenticator code
 */
router.post('/settings/2fa/disable', protectRoute, validateCsrfToken, async (req, res) => {
  try {
    const { code } = req.body;
    const valid = await verifyUserTotpToken(req.user.userId, code);

    if (!valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid authentication code. Two-factor authentication was not disabled.'
      });
    }

    await disableUserMfa(req.user.userId);
    clearPendingMfaSetup(req);

    return res.json({
      success: true,
      message: 'Two-factor authentication has been turned off.'
    });
  } catch (error) {
    console.error('2FA disable error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to disable two-factor authentication'
    });
  }
});

/**
 * POST /settings/regenerate-key
 * Regenerate user's API key
 * Requires authentication
 */
router.post('/settings/regenerate-key', protectRoute, validateCsrfToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Regenerate API key
    await regenerateApiKey(userId);

    // Redirect back to settings with success message
    res.redirect('/settings?success=true');

  } catch (error) {
    console.error('API key regeneration error:', error);
    res.redirect('/settings?error=true');
  }
});

/**
 * POST /settings/delete-account
 * Delete user account and all associated data
 * Requires authentication
 */
router.post('/settings/delete-account', protectRoute, validateCsrfToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { confirmEmail } = req.body;
    const userEmail = req.user.email;

    // Verify the user typed their email correctly for confirmation
    if (!confirmEmail || confirmEmail.toLowerCase() !== userEmail.toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: 'Email confirmation does not match. Please type your email address exactly.'
      });
    }

    // Delete all user data (cascading deletes will handle related data)
    // The database has ON DELETE CASCADE for agents, messages, etc.
    await query('DELETE FROM users WHERE user_id = $1', [userId]);

    // Destroy the session
    await destroySession(req);

    // Return success
    res.json({
      success: true,
      message: 'Your account has been permanently deleted.',
      redirect: '/'
    });

  } catch (error) {
    console.error('Account deletion error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete account. Please try again or contact support.'
    });
  }
});

/**
 * GET /dashboard/config
 * Get current agent configuration and allowed permissions (session-authenticated for frontend)
 */
router.get('/dashboard/config', protectRoute, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName } = req.query;

    if (!agentName) {
      return res.status(400).json({ error: { message: 'agentName is required' } });
    }

    const agentResult = await query(
      'SELECT inter_agent_mode FROM agents WHERE user_id = $1 AND agent_name = $2',
      [userId, agentName]
    );
    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Agent not found' } });
    }

    const runtimeState = await loadAgentRuntimeState({
      userId,
      agentName,
      defaults: DEFAULT_DASHBOARD_CONFIG
    });
    let config = runtimeState.config;
    const allowedPermissions = runtimeState.allowedPermissions;

    // Get inter_agent_mode from database
    let interAgentMode = 'disabled';
    try {
      if (agentResult.rows.length > 0 && agentResult.rows[0].inter_agent_mode) {
        interAgentMode = agentResult.rows[0].inter_agent_mode;
      }
    } catch (dbError) {
      console.warn('Failed to get inter_agent_mode from database:', dbError);
    }

    // Default A2A communication to ON when permissions allow it
    if (interAgentMode === 'disabled' && allowedPermissions.inter_agent) {
      const ia = allowedPermissions.inter_agent;
      if (ia.enabled === true) {
        interAgentMode = ia.mode || 'listen_all';
      }
    }

    // Compute max permissions from allowed_permissions — always default to the most
    // permissive settings the user allowed during agent setup
    const hasPermissions = Object.keys(allowedPermissions).some(k => !['inter_agent', 'project_path'].includes(k));

    if (hasPermissions) {
      const provider = config.model_provider || 'codex';
      const providerPerms = allowedPermissions[provider] || {};

      if (provider === 'codex' || provider === 'default' || provider === 'ollama' || provider === 'openrouter') {
        if (providerPerms['--dangerously-bypass-approvals-and-sandbox'] === true) {
          config.approval_mode = 'full-auto';
          config.sandbox_mode = 'none';
        } else {
          const allowedSandboxes = providerPerms['--sandbox'] || [];
          if (allowedSandboxes.includes('danger-full-access')) {
            config.sandbox_mode = 'none';
            config.approval_mode = 'full-auto';
          } else if (allowedSandboxes.includes('workspace-write')) {
            config.sandbox_mode = 'workspace-write';
            config.approval_mode = 'full-auto';
          }
        }
      } else if (provider === 'claude') {
        if (providerPerms['--dangerously-skip-permissions'] === true) {
          config.sandbox_mode = 'none';
        }
        const allowedModes = providerPerms['--permission-mode'] || [];
        if (allowedModes.includes('bypassPermissions')) {
          config.approval_mode = 'bypassPermissions';
          config.sandbox_mode = 'none';
        } else if (allowedModes.includes('acceptEdits')) {
          config.approval_mode = 'acceptEdits';
        }
      } else if (provider === 'gemini') {
        if (providerPerms['--yolo'] === true) {
          config.approval_mode = 'full-auto';
        }
        if (providerPerms['--no-sandbox'] === true) {
          config.sandbox_mode = 'none';
        }
      } else if (provider === 'copilot') {
        if (providerPerms['--allow-all'] === true || providerPerms['--yolo'] === true) {
          config.approval_mode = 'full-auto';
          config.sandbox_mode = 'none';
        } else if (providerPerms['--allow-all-tools'] === true) {
          config.approval_mode = 'full-auto';
        }
      }
    }

    res.json({ config, allowedPermissions, interAgentMode });
  } catch (error) {
    console.error('Get config error:', error);
    res.status(500).json({ error: { message: 'Failed to get config' } });
  }
});

/**
 * PUT /dashboard/config
 * Update agent configuration (session-authenticated for frontend)
 */
router.put('/dashboard/config', protectRoute, validateCsrfToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName, model_provider, model, approval_mode, sandbox_mode, thinking_effort } = req.body;
    const normalizedSandboxMode = sandbox_mode === 'danger-full-access' ? 'none' : sandbox_mode;
    if (thinking_effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(thinking_effort)) {
      return res.status(400).json({ error: { message: 'thinking_effort must be low, medium, high, xhigh, or max' } });
    }

    if (!agentName) {
      return res.status(400).json({ error: { message: 'agentName is required' } });
    }

    const runtimeState = await loadAgentRuntimeState({
      userId,
      agentName,
      defaults: DEFAULT_DASHBOARD_CONFIG
    });
    const allowedPermissions = runtimeState.allowedPermissions;

    // Validate provider is allowed (if permissions file exists and has entries)
    const allowedProviders = Object.keys(allowedPermissions).filter(
      (key) => !['inter_agent', 'project_path'].includes(key)
    );
    if (allowedProviders.length > 0 && model_provider) {
      if (!allowedPermissions[model_provider]) {
        return res.status(403).json({
          error: {
            message: `Provider '${model_provider}' is not allowed. Allowed: ${allowedProviders.join(', ')}`
          }
        });
      }
    }

    const agentResult = await query(
      'SELECT agent_id FROM agents WHERE user_id = $1 AND agent_name = $2',
      [userId, agentName]
    );
    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Agent not found' } });
    }

    let config = { ...runtimeState.config };

    // Update with new values
    if (model_provider) config.model_provider = model_provider;
    if (model) config.model = model;
    if (approval_mode) config.approval_mode = approval_mode;
    if (normalizedSandboxMode !== undefined) config.sandbox_mode = normalizedSandboxMode;
    if (thinking_effort !== undefined) config.thinking_effort = thinking_effort;
    config.updated_at = new Date().toISOString();

    await persistAgentRuntimeState({
      agentId: agentResult.rows[0].agent_id,
      config,
      allowedPermissions
    });
    syncRuntimeStateToFilesystem({
      agentDir: runtimeState.agentDir,
      config,
      allowedPermissions
    });

    // Update inter_agent_mode in database if provided
    const { inter_agent_mode } = req.body;
    if (inter_agent_mode) {
      try {
        await query(
          'UPDATE agents SET inter_agent_mode = $1 WHERE user_id = $2 AND agent_name = $3',
          [inter_agent_mode, userId, agentName]
        );
      } catch (dbError) {
        console.warn('Failed to update inter_agent_mode in database:', dbError);
      }
    }

    res.json({ success: true, config });
  } catch (error) {
    console.error('Update config error:', error);
    res.status(500).json({ error: { message: 'Failed to update config' } });
  }
});

/**
 * GET /dashboard/models
 * Return provider/model catalog for frontend dropdowns.
 * Includes static defaults plus user-specific synced models pushed from CLI.
 */
router.get('/dashboard/models', protectRoute, async (req, res) => {
  try {
    const userId = req.user.userId;
    const models = getProviderModelCatalog(userId);
    res.json({ models, updatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Get dashboard models error:', error);
    res.status(500).json({ error: { message: 'Failed to load provider models' } });
  }
});

/**
 * POST /dashboard/stop
 * Stop the agent by setting DB flag, writing filesystem stop flag, and killing process
 */
router.post('/dashboard/stop', protectRoute, validateCsrfToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName } = req.body;

    if (!agentName) {
      return res.status(400).json({ error: { message: 'agentName is required' } });
    }

    const stopTimestamp = new Date();

    // 1. Set stop flag in database (works for remote agents via heartbeat)
    try {
      await query(
        'UPDATE agents SET stop_requested_at = $1 WHERE user_id = $2 AND agent_name = $3',
        [stopTimestamp, userId, agentName]
      );
    } catch (dbErr) {
      console.error('Failed to set DB stop flag:', dbErr);
    }

    // 2. Write filesystem stop flag + kill process (works for local agents)
    const agentFolder = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const possiblePaths = [
      path.join(process.cwd(), '.chatspace', agentFolder),
      path.join(process.env.HOME || '', '.chatspace', agentFolder),
      path.join(process.cwd(), 'chatspace', agentFolder),
      path.join(process.env.HOME || '', 'chatspace', agentFolder)
    ];

    let agentDir = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        agentDir = p;
        break;
      }
    }

    let processKilled = false;
    let forceKilled = false;
    if (agentDir) {
      const stateDir = path.join(agentDir, 'agent_state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, '.stop_requested'), stopTimestamp.toISOString());

      // Kill the process via PID file
      const pidPath = path.join(stateDir, '.agent_pid');
      const pid = readPidFromFile(pidPath);
      if (pid) {
        const killResult = terminateProcessWithEscalation(pid);
        processKilled = killResult.processKilled;
        forceKilled = killResult.forceKilled;
      }
    }

    res.json({
      success: true,
      message: forceKilled
        ? 'Agent process force-killed by failsafe.'
        : processKilled
        ? 'Agent process killed.'
        : 'Stop signal sent. Agent will halt at next heartbeat.',
      processKilled,
      forceKilled
    });
  } catch (error) {
    console.error('Stop agent error:', error);
    res.status(500).json({ error: { message: 'Failed to stop agent' } });
  }
});

/**
 * GET /archive
 * Render archive page with archived agents
 * Requires authentication
 */
router.get('/archive', protectRoute, async (req, res) => {
  try {
    const userId = req.user.userId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    // Fetch archived agents with pagination
    const archiveService = require('../services/archiveService');
    const result = await archiveService.getArchivedAgents(userId, { limit: limit + 1, offset });

    // Check if there are more results
    const hasMore = result.archivedAgents.length > limit;
    if (hasMore) {
      result.archivedAgents = result.archivedAgents.slice(0, limit);
    }

    const totalPages = Math.ceil(result.total / limit);

    res.render('archive', {
      user: req.user,
      archivedAgents: result.archivedAgents,
      currentPage: page,
      totalPages: totalPages,
      totalCount: result.total
    });

  } catch (error) {
    console.error('Archive page error:', error);
    res.status(500).render('error', {
      statusCode: 500,
      error: 'Failed to load archive'
    });
  }
});

module.exports = router;
