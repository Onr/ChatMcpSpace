/**
 * Page Routes
 * Handles all page rendering routes (registration, login, dashboard, settings)
 */

const express = require('express');
const router = express.Router();
const passport = require('passport');
const { registerUser, validateCredentials, createSession, destroySession, regenerateApiKey } = require('../services/authService');
const { sendVerificationEmail, verifyEmailToken, verifyEmailCode, resendVerificationEmail, isEmailVerified } = require('../services/emailService');
const { protectRoute } = require('../middleware/authMiddleware');
const { authRateLimiter } = require('../middleware/rateLimitMiddleware');
const { csrfProtection, validateCsrfToken } = require('../middleware/csrfMiddleware');
const { logAuthenticationFailure } = require('../utils/securityLogger');
const { query } = require('../db/connection');
const { isValidEmail, validatePasswordStrength } = require('../utils/validation');
const { generateApiGuide, generateDirectSetupScript, generateMainCLIScript } = require('../utils/apiGuideGenerator');
const { generateEncryptionSalt } = require('../utils/encryptionHelper');

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

# Fetch customized script with spinner
gum spin --spinner dot --title "Fetching your customized CLI script..." -- \\
    bash -c "curl -sL -w '\\n%{http_code}' -H 'X-API-Key: $API_KEY' '${baseUrl}/api/agent/cli-script' > /tmp/cli_response_$$.txt 2>&1"

if [ ! -f "/tmp/cli_response_$$.txt" ]; then
    echo ""
    gum style --foreground 196 "✗ Error: Failed to fetch script (network error)"
    exit 1
fi

RESPONSE=$(cat /tmp/cli_response_$$.txt)
rm -f /tmp/cli_response_$$.txt

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
SCRIPT=$(echo "$RESPONSE" | sed '$d')

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
    exit 1
fi

echo ""
gum style --foreground 46 "✓ Script fetched successfully"
echo ""

# Optional preview (default to No for faster installation)
if gum confirm "Preview script before saving?" --default=false < /dev/tty; then
    echo ""
    gum style --border normal --border-foreground 212 --padding "0 1" "First 20 lines of script:"
    echo "$SCRIPT" | head -20 | gum style --foreground 250
    echo ""

    if ! gum confirm "Continue with installation?" --default=true < /dev/tty; then
        gum style --foreground 245 "Installation cancelled."
        exit 0
    fi
    echo ""
fi

# Save to temp file first
echo "$SCRIPT" > "$TEMP_FILE"

# Move to final location
INSTALL_PATH="$(pwd)/agent-cli.sh"
mv "$TEMP_FILE" "agent-cli.sh"
chmod +x agent-cli.sh

gum style --foreground 46 "✓ Saved to: $INSTALL_PATH"
echo ""

gum style \\
    --border double \\
    --border-foreground 46 \\
    --padding "1 2" \\
    --margin "1 0" \\
    --align center \\
    "✓ Setup Complete!"

echo ""
gum style --bold "Your CLI script has been saved to:"
gum style --foreground 212 "  $INSTALL_PATH"
echo ""

gum style --bold "To get started, run:"
gum style --foreground 212 "  bash agent-cli.sh"
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
 * GET /
 * Root route - show landing page or redirect to dashboard
 */
router.get('/', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render('landing', {
    error: null,
    email: ''
  });
});

/**
 * GET /demo
 * Demo page with hardcoded agents
 */
router.get('/demo', (req, res) => {
  const MarbleGenerator = require('../../public/js/marble-generator');
  
  const agents = [
    {
       agentId: 'demo-1',
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
    csrfToken: req.csrfToken(),
    agentsJSON: JSON.stringify(agents)
  });
});

/**
 * GET /auth/google
 * Initiate Google OAuth authentication
 */
router.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

/**
 * GET /auth/google/callback
 * Handle Google OAuth callback
 */
router.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  async (req, res) => {
    try {
      // Create session for the authenticated user
      await createSession(req, req.user);
      req.session.emailVerified = true;
      req.session.isGoogleAuth = true;  // Track OAuth login for encryption prompt
      res.redirect('/dashboard');
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
 * GET /register
 * Render registration page
 */
router.get('/register', (req, res) => {
  // If already logged in, redirect to dashboard
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }

  res.render('register', {
    error: null,
    email: ''
  });
});

/**
 * POST /register
 * Handle user registration
 */
router.post('/register', authRateLimiter, validateCsrfToken, async (req, res) => {
  try {
    const { email, password, confirmPassword } = req.body;

    // Validate input
    if (!email || !password) {
      return res.render('register', {
        error: 'Email and password are required',
        email: email || ''
      });
    }

    // Validate email format
    if (!isValidEmail(email)) {
      return res.render('register', {
        error: 'Please enter a valid email address',
        email: email
      });
    }

    // Validate password strength
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return res.render('register', {
        error: passwordValidation.message,
        email: email
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

    // Send verification email
    const emailResult = await sendVerificationEmail(user.userId, email, {
      ip: req.ip,
      userAgent: req.get('user-agent')
    });

    // Store email temporarily in session for the verify-email-sent page
    // But do NOT log the user in - they must verify email first
    req.session.pendingVerificationEmail = email;

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
      email: req.body.email || ''
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

  // If no pending email and user is not logged in, redirect to home
  if (!email && !req.session?.userId) {
    return res.redirect('/');
  }

  res.render('verify-email-sent', {
    email: email || req.session?.email || null
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
router.post('/verify-code', authRateLimiter, async (req, res) => {
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
      alreadyVerified: result.alreadyVerified || false
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
    return res.redirect('/dashboard');
  }

  // Redirect to landing page which has the login form
  res.redirect('/');
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
      return res.render('landing', {
        error: 'Email and password are required',
        email: email || ''
      });
    }

    // Validate credentials
    const user = await validateCredentials(email, password);

    if (!user) {
      // Log authentication failure
      logAuthenticationFailure(req, email, 'Invalid credentials');

      return res.render('landing', {
        error: 'Invalid email or password',
        email: email
      });
    }

    // Check if email is not verified
    if (user.emailNotVerified) {
      // Store email in session for the verify-email-sent page
      req.session.pendingVerificationEmail = user.email;

      return res.render('landing', {
        error: 'Please verify your email before logging in. Check your inbox for the verification link.',
        email: email
      });
    }

    // Create session
    await createSession(req, user);

    // Redirect to dashboard
    res.redirect('/dashboard');

  } catch (error) {
    console.error('Login error:', error);
    res.render('landing', {
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
router.get('/dashboard', protectRoute, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Fetch encryption salt so the browser can derive the decryption key
    const saltResult = await query(
      'SELECT encryption_salt FROM users WHERE user_id = $1',
      [userId]
    );

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
      GROUP BY a.agent_id, a.agent_name, a.agent_type, a.position, a.last_seen_at
      ORDER BY a.position ASC
    `, [userId]);

    // Format agent data
    const MarbleGenerator = require('../../public/js/marble-generator');

    const agents = agentsResult.rows.map(row => {
      // Use last_seen_at (when agent sent message or checked for updates) as the primary activity indicator
      const lastActivityTime = row.last_seen_at || row.last_message_time;
      const lastMessageTime = row.last_message_time;
      const lastMessageId = row.last_message_id;
      return {
        agentId: row.agent_id,
        name: row.agent_name,
        agentType: row.agent_type || 'standard',
        position: row.position,
        lastMessageId: lastMessageId || null,
        lastMessageTime: lastMessageTime ? lastMessageTime.toISOString() : null,
        lastActivityTime: lastActivityTime ? lastActivityTime.toISOString() : null,
        unreadCount: parseInt(row.unread_count) || 0,
        highestPriority: row.priority_value === 3 ? 'high' : row.priority_value === 2 ? 'normal' : 'low',
        lastMessagePriority: row.last_message_priority === 2 ? 'high' : row.last_message_priority === 1 ? 'normal' : 'low',
        marbleSvg: MarbleGenerator.generateMarble(row.agent_id, 100, row.agent_name, 'ssr')
      };
    });

    res.render('dashboard', {
      user: req.user,
      agents: agents,
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

    // Build path to agent's config files
    const agentFolder = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const fs = require('fs');
    const path = require('path');

    // Default config
    let config = {
      model_provider: 'codex',
      model: 'default',
      approval_mode: 'suggest',
      sandbox_mode: 'workspace-write'
    };

    // Default allowed permissions (empty = all allowed for backwards compat)
    let allowedPermissions = {};

    // Try to find the agent's chatspace directory
    const possiblePaths = [
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

    if (agentDir) {
      // Load config
      const configPath = path.join(agentDir, 'agent_state', 'agent_config.json');
      if (fs.existsSync(configPath)) {
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
          console.warn('Failed to parse agent config:', e);
        }
      }

      // Load allowed permissions
      const permsPath = path.join(agentDir, 'agent_state', 'allowed_permissions.json');
      if (fs.existsSync(permsPath)) {
        try {
          allowedPermissions = JSON.parse(fs.readFileSync(permsPath, 'utf8'));
        } catch (e) {
          console.warn('Failed to parse allowed permissions:', e);
        }
      }
    }

    res.json({ config, allowedPermissions });
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
    const { agentName, model_provider, model, approval_mode, sandbox_mode } = req.body;

    if (!agentName) {
      return res.status(400).json({ error: { message: 'agentName is required' } });
    }

    // Build path to agent's config files  
    const agentFolder = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const fs = require('fs');
    const path = require('path');

    const possiblePaths = [
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

    // If directory doesn't exist, create it in the cwd/chatspace location
    if (!agentDir) {
      agentDir = path.join(process.cwd(), 'chatspace', agentFolder);
      fs.mkdirSync(path.join(agentDir, 'agent_state'), { recursive: true });
      console.log(`Created agent directory: ${agentDir}`);
    }

    // Load allowed permissions to validate
    const permsPath = path.join(agentDir, 'agent_state', 'allowed_permissions.json');
    let allowedPermissions = {};
    if (fs.existsSync(permsPath)) {
      try {
        allowedPermissions = JSON.parse(fs.readFileSync(permsPath, 'utf8'));
      } catch (e) {
        console.warn('Failed to parse allowed permissions:', e);
      }
    }

    // Validate provider is allowed (if permissions file exists and has entries)
    const allowedProviders = Object.keys(allowedPermissions);
    if (allowedProviders.length > 0 && model_provider) {
      if (!allowedPermissions[model_provider]) {
        return res.status(403).json({
          error: {
            message: `Provider '${model_provider}' is not allowed. Allowed: ${allowedProviders.join(', ')}`
          }
        });
      }
    }

    const configPath = path.join(agentDir, 'agent_state', 'agent_config.json');

    // Ensure directory exists
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    // Load existing config or create new
    let config = {};
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (e) {
        config = {};
      }
    }

    // Update with new values
    if (model_provider) config.model_provider = model_provider;
    if (model) config.model = model;
    if (approval_mode) config.approval_mode = approval_mode;
    if (sandbox_mode !== undefined) config.sandbox_mode = sandbox_mode;
    config.updated_at = new Date().toISOString();

    // Write config
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    res.json({ success: true, config });
  } catch (error) {
    console.error('Update config error:', error);
    res.status(500).json({ error: { message: 'Failed to update config' } });
  }
});

/**
 * POST /dashboard/stop
 * Stop the agent by creating .stop_requested file (session-authenticated)
 */
router.post('/dashboard/stop', protectRoute, validateCsrfToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { agentName } = req.body;

    if (!agentName) {
      return res.status(400).json({ error: { message: 'agentName is required' } });
    }

    const agentFolder = agentName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const fs = require('fs');
    const path = require('path');

    const possiblePaths = [
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

    if (!agentDir) {
      return res.status(404).json({
        error: {
          message: 'Agent not running locally. Run the agent setup script first to create the local workspace.'
        }
      });
    }

    const stopFlagPath = path.join(agentDir, 'agent_state', '.stop_requested');

    // Create stop flag file
    fs.mkdirSync(path.dirname(stopFlagPath), { recursive: true });
    fs.writeFileSync(stopFlagPath, new Date().toISOString());

    res.json({ success: true, message: 'Stop signal sent' });
  } catch (error) {
    console.error('Stop agent error:', error);
    res.status(500).json({ error: { message: 'Failed to stop agent' } });
  }
});

module.exports = router;
