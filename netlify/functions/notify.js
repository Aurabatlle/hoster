// netlify/functions/notify.js
// Deploy this file to your Netlify project at: netlify/functions/notify.js
//
// Set these environment variables in Netlify Dashboard → Site Settings → Environment Variables:
//   FIREBASE_PROJECT_ID       = aura-battle-main
//   FIREBASE_CLIENT_EMAIL     = firebase-adminsdk-fbsvc@aura-battle-main.iam.gserviceaccount.com
//   FIREBASE_PRIVATE_KEY      = (paste the full private key including -----BEGIN/END PRIVATE KEY-----)
//   FIREBASE_DATABASE_URL     = https://aura-battle-main-default-rtdb.firebaseio.com

const admin = require('firebase-admin');

// Initialize only once (Netlify functions can be warm)
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId:   process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            // Netlify stores newlines as literal \n — replace them back
            privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
}

exports.handler = async (event) => {
    // Only allow POST
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    let body;
    try {
        body = JSON.parse(event.body);
    } catch (_) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { matchId, type } = body;
    // type: 'room_details' | 'match_started' | 'match_cancelled'

    if (!matchId || !type) {
        return { statusCode: 400, body: JSON.stringify({ error: 'matchId and type required' }) };
    }

    try {
        const db = admin.database();

        // 1. Get match data
        const matchSnap = await db.ref('matches/' + matchId).once('value');
        if (!matchSnap.exists()) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Match not found' }) };
        }
        const match = matchSnap.val();

        // 2. Get all joined players for this match
        const registrationsSnap = await db.ref('registrations')
            .orderByChild('matchId').equalTo(matchId).once('value');

        if (!registrationsSnap.exists()) {
            return { statusCode: 200, body: JSON.stringify({ success: true, sent: 0, message: 'No players joined' }) };
        }

        // 3. Collect user IDs
        const userIds = [];
        registrationsSnap.forEach(child => {
            const uid = child.val().userId;
            if (uid) userIds.push(uid);
        });

        if (userIds.length === 0) {
            return { statusCode: 200, body: JSON.stringify({ success: true, sent: 0 }) };
        }

        // 4. Fetch FCM tokens for each user
        const tokens = [];
        for (const uid of userIds) {
            const userSnap = await db.ref('users/' + uid).once('value');
            if (userSnap.exists()) {
                const fcmToken = userSnap.val().fcmToken;
                if (fcmToken) tokens.push(fcmToken);
            }
        }

        if (tokens.length === 0) {
            return { statusCode: 200, body: JSON.stringify({ success: true, sent: 0, message: 'No FCM tokens found' }) };
        }

        // 5. Build notification message
        const messages = {
            room_details: {
                title: '🔑 Room Details Added!',
                body: `Match #${matchId} — ${match.title}. Room ID & Password are ready. Get in now!`,
            },
            match_started: {
                title: '🔥 Match Started!',
                body: `#${matchId} ${match.title} is now LIVE! Join the room immediately.`,
            },
            match_cancelled: {
                title: '❌ Match Cancelled',
                body: `Match #${matchId} — ${match.title} has been cancelled by the host.`,
            },
        };

        const notif = messages[type];
        if (!notif) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Unknown notification type' }) };
        }

        // 6. Send multicast
        const message = {
            tokens,
            notification: {
                title: notif.title,
                body:  notif.body,
            },
            data: {
                matchId,
                type,
                matchTitle: match.title || '',
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
            },
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    channelId: 'match_alerts',
                },
            },
        };

        const response = await admin.messaging().sendEachForMulticast(message);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                sent: response.successCount,
                failed: response.failureCount,
                total: tokens.length,
            }),
        };

    } catch (err) {
        console.error('notify function error:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message }),
        };
    }
};
