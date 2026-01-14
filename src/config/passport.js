const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { query } = require('../db/connection');
const { generateApiKey, generateScriptToken, createSession } = require('../services/authService');
const { generateEncryptionSalt } = require('../utils/encryptionHelper');

passport.serializeUser((user, done) => {
    done(null, user.userId);
});

passport.deserializeUser(async (id, done) => {
    try {
        const result = await query('SELECT user_id, email, api_key, encryption_salt FROM users WHERE user_id = $1', [id]);
        if (result.rows.length > 0) {
            let encryptionSalt = result.rows[0].encryption_salt;

            // Generate encryption_salt if missing (legacy user)
            if (!encryptionSalt) {
                encryptionSalt = generateEncryptionSalt();
                await query('UPDATE users SET encryption_salt = $1 WHERE user_id = $2', [encryptionSalt, id]);
                console.log(`deserializeUser: Generated encryption_salt for legacy user: ${result.rows[0].email}`);
            }

            const user = {
                userId: result.rows[0].user_id,
                email: result.rows[0].email,
                apiKey: result.rows[0].api_key,
                encryptionSalt: encryptionSalt
            };
            done(null, user);
        } else {
            // User not found in DB (deleted account or stale session)
            // Pass false to indicate invalid session - Passport will clear it
            console.warn('deserializeUser: User not found in database, clearing stale session');
            done(null, false);
        }
    } catch (err) {
        done(err, null);
    }
});

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'dummy_client_id',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'dummy_client_secret',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
    passReqToCallback: true
},
    async function (req, accessToken, refreshToken, profile, cb) {
        try {
            const email = profile.emails[0].value;
            const googleId = profile.id;

            // 1. Check if user exists with this google_id
            const googleUserResult = await query('SELECT user_id, email, api_key, encryption_salt FROM users WHERE google_id = $1', [googleId]);

            if (googleUserResult.rows.length > 0) {
                const user = {
                    userId: googleUserResult.rows[0].user_id,
                    email: googleUserResult.rows[0].email,
                    apiKey: googleUserResult.rows[0].api_key,
                    encryptionSalt: googleUserResult.rows[0].encryption_salt
                };
                return cb(null, user);
            }

            // 2. Check if user exists with this email (if so, link google_id)
            const emailUserResult = await query('SELECT user_id, email, api_key, encryption_salt FROM users WHERE email = $1', [email]);

            if (emailUserResult.rows.length > 0) {
                const userId = emailUserResult.rows[0].user_id;
                let userEncryptionSalt = emailUserResult.rows[0].encryption_salt;

                // Generate encryption_salt if missing (legacy user)
                if (!userEncryptionSalt) {
                    userEncryptionSalt = generateEncryptionSalt();
                    await query('UPDATE users SET google_id = $1, email_verified = TRUE, encryption_salt = $2 WHERE user_id = $3', [googleId, userEncryptionSalt, userId]);
                } else {
                    await query('UPDATE users SET google_id = $1, email_verified = TRUE WHERE user_id = $2', [googleId, userId]);
                }

                const user = {
                    userId: userId,
                    email: emailUserResult.rows[0].email,
                    apiKey: emailUserResult.rows[0].api_key,
                    encryptionSalt: userEncryptionSalt
                };
                return cb(null, user);
            }

            // 3. Create new user
            const apiKey = generateApiKey();
            const encryptionSalt = generateEncryptionSalt();
            const scriptToken = generateScriptToken();

            const newUserResult = await query(
                `INSERT INTO users (email, google_id, api_key, encryption_salt, script_token, email_verified, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, NOW())
         RETURNING user_id, email, api_key, encryption_salt, script_token`,
                [email, googleId, apiKey, encryptionSalt, scriptToken]
            );

            const newUser = {
                userId: newUserResult.rows[0].user_id,
                email: newUserResult.rows[0].email,
                apiKey: newUserResult.rows[0].api_key,
                encryptionSalt: newUserResult.rows[0].encryption_salt,
                scriptToken: newUserResult.rows[0].script_token
            };

            return cb(null, newUser);

        } catch (err) {
            return cb(err);
        }
    }
));

module.exports = passport;
