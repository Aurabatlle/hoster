// netlify/functions/notify.js
//
// Uses google-auth-library (same as your working send-push.js — no firebase-admin needed)
//
// Netlify Environment Variable needed (just ONE):
//   FIREBASE_SERVICE_ACCOUNT  =  paste the entire JSON content of your service account key file
//
// Data structure expected in Firebase:
//   matches/{matchId}/players/{playerKey}/userId   → used to look up FCM token
//   users/{userId}/fcmToken                        → FCM token for notification

const { GoogleAuth } = require('google-auth-library');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const { matchId, type, matchTitle } = JSON.parse(event.body);

    if (!matchId || !type) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'matchId and type are required' }) };
    }

    // ── Service account from env var ─────────────────────────────────────────
    const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const projectId = SERVICE_ACCOUNT.project_id;
    const databaseURL = `const databaseURL = 'https://aura-battle-main-default-rtdb.firebaseio.com';`;

    // ── Get OAuth2 access token ──────────────────────────────────────────────
    const auth = new GoogleAuth({
      credentials: SERVICE_ACCOUNT,
      scopes: [
        'https://www.googleapis.com/auth/firebase.messaging',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/firebase.database',
        'https://www.googleapis.com/auth/cloud-platform'
      ]
    });
    const client = await auth.getClient();
    const tokenData = await client.getAccessToken();
    const accessToken = tokenData.token;

    // ── Read match players from Firebase Database REST API ───────────────────
    const matchRes = await fetch(
      `${databaseURL}/matches/${matchId}/players.json?access_token=${accessToken}`
    );
    const playersData = await matchRes.json();

    if (!playersData || typeof playersData !== 'object') {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, sent: 0, message: 'No players in match' }) };
    }

    // ── Collect unique userIds from players ──────────────────────────────────
    const userIds = [...new Set(
      Object.values(playersData)
        .map(p => p.userId)
        .filter(Boolean)
    )];

    if (!userIds.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, sent: 0, message: 'No userIds found' }) };
    }

    // ── Fetch FCM tokens from users table ────────────────────────────────────
    const tokens = [];
    for (const uid of userIds) {
      const userRes = await fetch(
        `${databaseURL}/users/${uid}/fcmToken.json?access_token=${accessToken}`
      );
      const token = await userRes.json();
      if (token && typeof token === 'string' && token.length > 10) {
        tokens.push(token);
      }
    }

    if (!tokens.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, sent: 0, message: 'No FCM tokens found' }) };
    }

    // ── Build notification content ────────────────────────────────────────────
    const title_text = matchTitle || `Match #${matchId}`;
    const messages = {
      room_details: {
        title: '🔑 Room Details Added!',
        body: `${title_text} — Room ID & Password are ready. Get in now!`
      },
      match_started: {
        title: '🔥 Match Started!',
        body: `${title_text} is now LIVE! Join the room immediately.`
      },
      match_cancelled: {
        title: '❌ Match Cancelled',
        body: `${title_text} has been cancelled by the host.`
      }
    };

    const notif = messages[type];
    if (!notif) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown type. Use: room_details, match_started, match_cancelled' }) };
    }

    // ── Send one FCM message per token (FCM v1 API) ───────────────────────────
    let successCount = 0, failCount = 0;

    for (const token of tokens) {
      const message = {
        message: {
          token,
          notification: {
            title: notif.title,
            body: notif.body
          },
          data: {
            matchId: String(matchId),
            type: String(type),
            click_action: 'FLUTTER_NOTIFICATION_CLICK'
          },
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              click_action: 'FLUTTER_NOTIFICATION_CLICK'
            }
          }
        }
      };

      const fcmRes = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(message)
        }
      );

      const result = await fcmRes.json();
      if (fcmRes.ok) successCount++;
      else { failCount++; console.error('FCM error for token:', result); }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, sent: successCount, failed: failCount, total: tokens.length })
    };

  } catch (err) {
    console.error('notify error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
