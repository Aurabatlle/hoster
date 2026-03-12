const { GoogleAuth } = require('google-auth-library');

// ── Firebase REST helpers ─────────────────────────────────────────────────────
async function firebaseGet(path, dbUrl) {
  const res = await fetch(`${dbUrl}/${path}.json`);
  if (!res.ok) throw new Error(`Firebase GET failed: ${res.status}`);
  return res.json();
}

// ── FCM send (single token) ───────────────────────────────────────────────────
async function sendOne(accessToken, projectId, token, title, body, data = {}) {
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title, body },
          data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
          android: {
            priority: 'high',
            notification: { sound: 'default', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
          }
        }
      })
    }
  );
  return res.ok;
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {

    // ── Check env vars first ──────────────────────────────────────────────────
    if (!process.env.FIREBASE_SERVICE_ACCOUNT)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env: FIREBASE_SERVICE_ACCOUNT' }) };
    if (!process.env.FIREBASE_DB_URL)
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env: FIREBASE_DB_URL' }) };

    // ── Parse body ────────────────────────────────────────────────────────────
    if (!event.body)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Request body is empty.' }) };

    const { matchId, type, reason } = JSON.parse(event.body);

    if (!matchId || !type)
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'matchId and type are required.' }) };

    // ── Firebase config from env ──────────────────────────────────────────────
    const SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const DB_URL = process.env.FIREBASE_DB_URL;

    // ── Get match details ─────────────────────────────────────────────────────
    const match = await firebaseGet(`matches/${matchId}`, DB_URL);
    if (!match) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Match not found: ' + matchId }) };

    // ── Build notification message ────────────────────────────────────────────
    let title, body;

    if (type === 'room_details') {
      title = `Room Details Updated of Match #${matchId}`;
      body  = `Join now the match #${matchId}\nRoom ID: ${match.roomId || '-'}  Password: ${match.roomPassword || '-'}`;
    } else if (type === 'match_started') {
      title = `#${matchId}`;
      body  = 'Match was started';
    } else if (type === 'match_cancelled') {
      title = 'Match Canceled';
      body  = `#${matchId} match was canceled due to ${reason || 'unknown reason'}`;
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown type: ' + type }) };
    }

    // ── Get joined players from match ─────────────────────────────────────────
    const playersSnap = match.players;
    if (!playersSnap || typeof playersSnap !== 'object')
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, message: 'No players joined yet.' }) };

    const playerEntries = Object.values(playersSnap);
    const userIds = [...new Set(playerEntries.map(p => p.userId).filter(Boolean))];

    if (userIds.length === 0)
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, message: 'No valid userIds found.' }) };

    // ── Fetch FCM tokens from users table ─────────────────────────────────────
    const fcmTokens = [];
    await Promise.all(
      userIds.map(async (uid) => {
        try {
          const user = await firebaseGet(`users/${uid}`, DB_URL);
          if (user && user.fcmToken && user.status !== 'banned') {
            fcmTokens.push(user.fcmToken);
          }
        } catch (_) {}
      })
    );

    if (fcmTokens.length === 0)
      return { statusCode: 200, headers, body: JSON.stringify({ sent: 0, message: 'No FCM tokens found for any player.' }) };

    // ── Get FCM access token ──────────────────────────────────────────────────
    const auth = new GoogleAuth({
      credentials: SERVICE_ACCOUNT,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    const client = await auth.getClient();
    const tokenData = await client.getAccessToken();
    const accessToken = tokenData.token;
    const projectId = SERVICE_ACCOUNT.project_id;

    // ── Send to all tokens ────────────────────────────────────────────────────
    const notifData = { matchId: String(matchId), type };
    const results = await Promise.allSettled(
      fcmTokens.map(token => sendOne(accessToken, projectId, token, title, body, notifData))
    );

    const sent = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    const failed = results.length - sent;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, sent, failed, total: fcmTokens.length })
    };

  } catch (err) {
    console.error('notify error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
