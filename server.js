require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================================================
// Configuration
// =============================================================================

const CONFIG = {
    clientId: process.env.ASANA_APP_CLIENT_ID,
    clientSecret: process.env.ASANA_APP_CLIENT_SECRET,
    port: process.env.PORT || 3000,
    baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    asanaApiBase: 'https://app.asana.com/api/1.0',
    asanaOAuthBase: 'https://app.asana.com/-/oauth_authorize',
    asanaTokenUrl: 'https://app.asana.com/-/oauth_token',

    // Asana workspace
    workspaceGid: process.env.ASANA_WORKSPACE_GID || '1207860012563297',

    // Stage custom field GID and enum option GIDs
    stageFieldGid: '1211547841344722',
    stageValues: {
        planning:    '1211547841344725',   // Planning       → START / RESUME
        development: '1211547841344726',   // Development    → START / RESUME
        onHold:      '1211547841344727',   // On Hold        → PAUSE
        completed:   '1211547841344729'    // Completd       → STOP
    },

    // "Time Tracked" custom field — will be created automatically or set manually
    // Set this after running POST /setup/create-time-field
    timeTrackedFieldGid: process.env.TIME_TRACKED_FIELD_GID || null
};

// =============================================================================
// Database Setup
// =============================================================================

const dbPath = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'timetracker.db')
    : path.join(__dirname, 'timetracker.db');
const db = new Database(dbPath);

db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
        user_gid TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timers (
        task_gid TEXT NOT NULL,
        user_gid TEXT NOT NULL,
        user_name TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        last_resumed_at TEXT NOT NULL,
        accumulated_seconds INTEGER DEFAULT 0,
        PRIMARY KEY (task_gid, user_gid)
    );

    CREATE TABLE IF NOT EXISTS time_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_gid TEXT NOT NULL,
        user_gid TEXT NOT NULL,
        user_name TEXT DEFAULT '',
        started_at TEXT NOT NULL,
        stopped_at TEXT,
        duration_seconds INTEGER DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_started (
        task_gid TEXT NOT NULL,
        user_gid TEXT NOT NULL,
        PRIMARY KEY (task_gid, user_gid)
    );

    CREATE INDEX IF NOT EXISTS idx_time_entries_task ON time_entries(task_gid);
    CREATE INDEX IF NOT EXISTS idx_timers_task ON timers(task_gid);
`);

// =============================================================================
// Prepared Statements
// =============================================================================

const stmts = {
    // Token management
    upsertToken: db.prepare(`
        INSERT INTO tokens (user_gid, access_token, refresh_token, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_gid) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at
    `),
    getToken: db.prepare('SELECT * FROM tokens WHERE user_gid = ?'),

    // Timer management
    createTimer: function(taskGid, userGid, userName) {
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        return db.prepare(`
            INSERT INTO timers (task_gid, user_gid, user_name, status, started_at, last_resumed_at, accumulated_seconds)
            VALUES (?, ?, ?, 'running', ?, ?, 0)
        `).run(taskGid, userGid, userName, now, now);
    },
    getTimer: db.prepare('SELECT * FROM timers WHERE task_gid = ? AND user_gid = ?'),
    getTimerForTask: db.prepare('SELECT * FROM timers WHERE task_gid = ?'),
    pauseTimer: db.prepare(`
        UPDATE timers SET status = 'paused', accumulated_seconds = ? WHERE task_gid = ? AND user_gid = ?
    `),
    resumeTimer: function(taskGid, userGid) {
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        return db.prepare(`
            UPDATE timers SET status = 'running', last_resumed_at = ? WHERE task_gid = ? AND user_gid = ?
        `).run(now, taskGid, userGid);
    },
    deleteTimer: db.prepare('DELETE FROM timers WHERE task_gid = ? AND user_gid = ?'),

    // Track which tasks have been started (prevent double start)
    markTaskStarted: db.prepare('INSERT OR IGNORE INTO task_started (task_gid, user_gid) VALUES (?, ?)'),
    hasTaskBeenStarted: db.prepare('SELECT 1 FROM task_started WHERE task_gid = ? AND user_gid = ?'),

    // Time entries (completed sessions)
    createEntry: function(taskGid, userGid, userName, startedAt, durationSeconds, notes) {
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        return db.prepare(`
            INSERT INTO time_entries (task_gid, user_gid, user_name, started_at, stopped_at, duration_seconds, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(taskGid, userGid, userName, startedAt, now, durationSeconds, notes, now);
    },
    getEntriesForTask: db.prepare('SELECT * FROM time_entries WHERE task_gid = ? ORDER BY created_at DESC'),
    getTotalTimeForTask: db.prepare('SELECT COALESCE(SUM(duration_seconds), 0) as total_seconds FROM time_entries WHERE task_gid = ?')
};

// =============================================================================
// Helper: Format seconds to readable time
// =============================================================================

function formatDuration(totalSeconds) {
    if (totalSeconds <= 0) return '0s';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}

// =============================================================================
// Helper: Calculate current elapsed seconds for a timer
// =============================================================================

function getTimerElapsed(timer) {
    if (!timer) return 0;

    let total = timer.accumulated_seconds || 0;

    // If running, add time since last resume
    if (timer.status === 'running') {
        const lastResumed = new Date(timer.last_resumed_at + 'Z');
        const elapsed = Math.floor((Date.now() - lastResumed.getTime()) / 1000);
        total += elapsed;
    }

    return total;
}

// =============================================================================
// Helper: Get Asana API client with token refresh
// =============================================================================

async function getAsanaClient(userGid) {
    const tokenRow = stmts.getToken.get(userGid);
    if (!tokenRow) return null;

    if (Date.now() >= (tokenRow.expires_at - 300) * 1000) {
        try {
            const response = await axios.post(CONFIG.asanaTokenUrl, new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: CONFIG.clientId,
                client_secret: CONFIG.clientSecret,
                refresh_token: tokenRow.refresh_token
            }));

            const { access_token, refresh_token, expires_in } = response.data;
            const expiresAt = Math.floor(Date.now() / 1000) + expires_in;

            stmts.upsertToken.run(userGid, access_token, refresh_token || tokenRow.refresh_token, expiresAt);

            return axios.create({
                baseURL: CONFIG.asanaApiBase,
                headers: { 'Authorization': `Bearer ${access_token}` }
            });
        } catch (err) {
            console.error('Token refresh failed:', err.message);
            return null;
        }
    }

    return axios.create({
        baseURL: CONFIG.asanaApiBase,
        headers: { 'Authorization': `Bearer ${tokenRow.access_token}` }
    });
}

// =============================================================================
// Helper: Post time summary to Asana task as comment + update custom field
// =============================================================================

async function postTimeSummaryToTask(taskGid, userGid, totalSeconds, action) {
    try {
        const client = await getAsanaClient(userGid);
        if (!client) return;

        // Post comment
        await client.post(`/tasks/${taskGid}/stories`, {
            data: {
                text: `[Time Tracker] ${action} — Total time: ${formatDuration(totalSeconds)}`
            }
        });

        // Update "Time Tracked" custom field if configured
        if (CONFIG.timeTrackedFieldGid) {
            await client.put(`/tasks/${taskGid}`, {
                data: {
                    custom_fields: {
                        [CONFIG.timeTrackedFieldGid]: formatDuration(totalSeconds)
                    }
                }
            });
        }
    } catch (err) {
        console.error('Failed to update Asana:', err.message);
    }
}

// =============================================================================
// Setup: Create "Time Tracked" custom field in workspace
// =============================================================================

app.post('/setup/create-time-field', async (req, res) => {
    const { user_gid, project_gids } = req.body;

    if (!user_gid) return res.status(400).json({ error: 'user_gid required' });

    const client = await getAsanaClient(user_gid);
    if (!client) return res.status(401).json({ error: 'No valid token. Visit /auth first.' });

    try {
        // Create custom field in workspace
        const fieldRes = await client.post('/custom_fields', {
            data: {
                workspace: CONFIG.workspaceGid,
                name: 'Time Tracked',
                resource_subtype: 'text',
                description: 'Auto-updated by Time Tracker app. Shows total time worked on this task.'
            }
        });

        const fieldGid = fieldRes.data.data.gid;
        console.log(`[Setup] Created "Time Tracked" field: ${fieldGid}`);

        // Add field to specified projects
        const addedToProjects = [];
        if (project_gids && project_gids.length > 0) {
            for (const projectGid of project_gids) {
                try {
                    await client.post(`/projects/${projectGid}/addCustomFieldSetting`, {
                        data: { custom_field: fieldGid }
                    });
                    addedToProjects.push(projectGid);
                } catch (e) {
                    console.error(`[Setup] Failed to add field to project ${projectGid}:`, e.message);
                }
            }
        }

        // Update config in memory
        CONFIG.timeTrackedFieldGid = fieldGid;

        res.json({
            message: 'Time Tracked field created successfully',
            field_gid: fieldGid,
            added_to_projects: addedToProjects,
            next_step: `Add TIME_TRACKED_FIELD_GID=${fieldGid} to your .env file to persist this setting`
        });
    } catch (err) {
        console.error('[Setup] Failed:', err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data || err.message });
    }
});

// =============================================================================
// OAuth Routes
// =============================================================================

app.get('/auth', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = `${CONFIG.asanaOAuthBase}?` + new URLSearchParams({
        client_id: CONFIG.clientId,
        redirect_uri: `${CONFIG.baseUrl}/auth/callback`,
        response_type: 'code',
        state: state
    });
    res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Authorization code missing');

    try {
        const tokenResponse = await axios.post(CONFIG.asanaTokenUrl, new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CONFIG.clientId,
            client_secret: CONFIG.clientSecret,
            redirect_uri: `${CONFIG.baseUrl}/auth/callback`,
            code: code
        }));

        const { access_token, refresh_token, expires_in, data } = tokenResponse.data;
        const expiresAt = Math.floor(Date.now() / 1000) + expires_in;
        stmts.upsertToken.run(data.gid, access_token, refresh_token, expiresAt);

        res.send(`
            <html>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h2>Connected to Asana Time Tracker</h2>
                <p>Welcome, ${data.name}! You can close this window.</p>
            </body>
            </html>
        `);
    } catch (err) {
        console.error('OAuth error:', err.response?.data || err.message);
        res.status(500).send('Authentication failed. Please try again.');
    }
});

// =============================================================================
// Widget: Shows timer state + buttons on each task
// =============================================================================

app.get('/widget', (req, res) => {
    const taskGid = req.query.task;
    const userGid = req.query.user;

    if (!taskGid) {
        return res.json({
            template: 'summary_with_details_v0',
            metadata: { title: 'Time Tracker', subtitle: 'No task' },
            data: { footer: '' }
        });
    }

    const timer = userGid ? stmts.getTimer.get(taskGid, userGid) : stmts.getTimerForTask.get(taskGid);
    const hasStarted = userGid ? stmts.hasTaskBeenStarted.get(taskGid, userGid) : null;
    const completedTime = stmts.getTotalTimeForTask.get(taskGid);
    const entries = stmts.getEntriesForTask.all(taskGid);

    const timerElapsed = getTimerElapsed(timer);
    const totalSeconds = completedTime.total_seconds + timerElapsed;

    // Determine state and available buttons
    let statusText, statusColor, buttons;

    if (!timer && !hasStarted) {
        // Never started — show Start button only
        statusText = 'Not Started';
        statusColor = 'grey';
        buttons = [{ text: 'Start', action: 'start', style: 'primary' }];
    } else if (timer && timer.status === 'running') {
        // Running — show Pause and Stop
        statusText = 'Running';
        statusColor = 'green';
        buttons = [
            { text: 'Pause', action: 'pause', style: 'default' },
            { text: 'Stop', action: 'stop', style: 'danger' }
        ];
    } else if (timer && timer.status === 'paused') {
        // Paused — show Resume and Stop
        statusText = `Paused (${formatDuration(timerElapsed)})`;
        statusColor = 'yellow';
        buttons = [
            { text: 'Resume', action: 'resume', style: 'primary' },
            { text: 'Stop', action: 'stop', style: 'danger' }
        ];
    } else {
        // Stopped (has been started before, timer deleted) — no Start button
        statusText = 'Stopped';
        statusColor = 'grey';
        buttons = [];
    }

    const fields = [
        {
            name: 'Timer',
            type: 'pill',
            text: statusText,
            color: statusColor
        },
        {
            name: 'Current Session',
            type: 'text_with_icon',
            text: timer ? formatDuration(timerElapsed) : '—'
        },
        {
            name: 'Total Time Logged',
            type: 'text_with_icon',
            text: formatDuration(totalSeconds)
        },
        {
            name: 'Completed Sessions',
            type: 'text_with_icon',
            text: `${entries.length}`
        }
    ];

    // Show recent entries
    entries.slice(0, 3).forEach((entry, i) => {
        fields.push({
            name: `Session ${i + 1}`,
            type: 'text_with_icon',
            text: `${formatDuration(entry.duration_seconds)} — ${entry.user_name || 'User'}${entry.notes ? ' (' + entry.notes + ')' : ''}`
        });
    });

    // Add button info as fields (Asana widget actions)
    if (buttons.length > 0) {
        fields.push({
            name: 'Actions',
            type: 'text_with_icon',
            text: buttons.map(b => b.text).join(' | ')
        });
    }

    res.json({
        template: 'summary_with_details_v0',
        metadata: {
            title: 'Time Tracker',
            subtitle: timer && timer.status === 'running'
                ? `Running: ${formatDuration(timerElapsed)}`
                : formatDuration(totalSeconds),
            num_comments: entries.length
        },
        data: {
            title: `Total: ${formatDuration(totalSeconds)}`,
            fields: fields,
            footer: statusText,
            buttons: buttons
        }
    });
});

// =============================================================================
// Timer Actions: Start / Pause / Resume / Stop
// =============================================================================

app.post('/action', async (req, res) => {
    const { action, task, user } = req.body;
    const taskGid = task;
    const userGid = user;

    if (!taskGid || !userGid) {
        return res.json({ error: 'Missing task or user' });
    }

    // Fetch user name
    let userName = '';
    try {
        const client = await getAsanaClient(userGid);
        if (client) {
            const userRes = await client.get(`/users/${userGid}`);
            userName = userRes.data.data.name || '';
        }
    } catch (e) { /* ignore */ }

    // ── START ──────────────────────────────────────────────────────────────
    if (action === 'start') {
        // Block: task already started by this user (no double start ever)
        const alreadyStarted = stmts.hasTaskBeenStarted.get(taskGid, userGid);
        if (alreadyStarted) {
            return res.json({ error: 'Timer already started on this task. You cannot start twice.' });
        }

        // Block: timer already exists
        const existing = stmts.getTimer.get(taskGid, userGid);
        if (existing) {
            return res.json({ error: 'Timer already exists on this task.' });
        }

        stmts.createTimer(taskGid, userGid, userName);
        stmts.markTaskStarted.run(taskGid, userGid);

        await postTimeSummaryToTask(taskGid, userGid, 0, 'Timer started');
        return res.json({ message: 'Timer started' });
    }

    // ── PAUSE ─────────────────────────────────────────────────────────────
    if (action === 'pause') {
        const timer = stmts.getTimer.get(taskGid, userGid);
        if (!timer) {
            return res.json({ error: 'No timer found for this task.' });
        }
        if (timer.status === 'paused') {
            return res.json({ error: 'Timer is already paused.' });
        }
        if (timer.status !== 'running') {
            return res.json({ error: 'Timer is not running.' });
        }

        // Calculate elapsed since last resume and add to accumulated
        const lastResumed = new Date(timer.last_resumed_at + 'Z');
        const elapsed = Math.floor((Date.now() - lastResumed.getTime()) / 1000);
        const newAccumulated = (timer.accumulated_seconds || 0) + elapsed;

        stmts.pauseTimer.run(newAccumulated, taskGid, userGid);

        await postTimeSummaryToTask(taskGid, userGid, newAccumulated, 'Timer paused');
        return res.json({ message: `Timer paused at ${formatDuration(newAccumulated)}` });
    }

    // ── RESUME ────────────────────────────────────────────────────────────
    if (action === 'resume') {
        const timer = stmts.getTimer.get(taskGid, userGid);
        if (!timer) {
            return res.json({ error: 'No timer found for this task.' });
        }
        if (timer.status === 'running') {
            return res.json({ error: 'Timer is already running.' });
        }
        if (timer.status !== 'paused') {
            return res.json({ error: 'Timer is not paused.' });
        }

        stmts.resumeTimer(taskGid, userGid);

        await postTimeSummaryToTask(taskGid, userGid, timer.accumulated_seconds, 'Timer resumed');
        return res.json({ message: 'Timer resumed' });
    }

    // ── STOP ──────────────────────────────────────────────────────────────
    if (action === 'stop') {
        const timer = stmts.getTimer.get(taskGid, userGid);
        if (!timer) {
            return res.json({ error: 'No timer found for this task.' });
        }

        // Calculate final total
        const totalSeconds = getTimerElapsed(timer);

        // Save as completed time entry
        stmts.createEntry(taskGid, userGid, userName, timer.started_at, totalSeconds, '');
        stmts.deleteTimer.run(taskGid, userGid);

        // Get grand total including all previous entries
        const grandTotal = stmts.getTotalTimeForTask.get(taskGid);

        await postTimeSummaryToTask(taskGid, userGid, grandTotal.total_seconds,
            `Timer stopped — Session: ${formatDuration(totalSeconds)}`);

        return res.json({
            message: `Timer stopped. Session: ${formatDuration(totalSeconds)}. Total: ${formatDuration(grandTotal.total_seconds)}`
        });
    }

    res.json({ error: 'Unknown action. Use: start, pause, resume, stop' });
});

// Keep legacy endpoint for backwards compatibility
app.post('/widget/action', (req, res) => {
    req.url = '/action';
    app.handle(req, res);
});

// =============================================================================
// REST API: Direct endpoints
// =============================================================================

// Get timer state + time entries for a task
app.get('/api/tasks/:taskGid/time', (req, res) => {
    const { taskGid } = req.params;
    const userGid = req.query.user_gid;

    const timer = userGid ? stmts.getTimer.get(taskGid, userGid) : stmts.getTimerForTask.get(taskGid);
    const hasStarted = userGid ? stmts.hasTaskBeenStarted.get(taskGid, userGid) : null;
    const completedTime = stmts.getTotalTimeForTask.get(taskGid);
    const entries = stmts.getEntriesForTask.all(taskGid);

    const timerElapsed = getTimerElapsed(timer);
    const totalSeconds = completedTime.total_seconds + timerElapsed;

    let availableActions = [];
    if (!timer && !hasStarted) {
        availableActions = ['start'];
    } else if (timer && timer.status === 'running') {
        availableActions = ['pause', 'stop'];
    } else if (timer && timer.status === 'paused') {
        availableActions = ['resume', 'stop'];
    }

    res.json({
        task_gid: taskGid,
        timer_status: timer ? timer.status : (hasStarted ? 'stopped' : 'not_started'),
        can_start: !hasStarted && !timer,
        current_session_seconds: timerElapsed,
        current_session_formatted: formatDuration(timerElapsed),
        total_seconds: totalSeconds,
        total_formatted: formatDuration(totalSeconds),
        available_actions: availableActions,
        entries: entries
    });
});

// Start timer
app.post('/api/tasks/:taskGid/timer/start', (req, res) => {
    const { taskGid } = req.params;
    const { user_gid, user_name } = req.body;
    if (!user_gid) return res.status(400).json({ error: 'user_gid is required' });

    const alreadyStarted = stmts.hasTaskBeenStarted.get(taskGid, user_gid);
    if (alreadyStarted) {
        return res.status(409).json({ error: 'Timer already started on this task. Cannot start twice.' });
    }

    const existing = stmts.getTimer.get(taskGid, user_gid);
    if (existing) {
        return res.status(409).json({ error: 'Timer already exists.' });
    }

    stmts.createTimer(taskGid, user_gid, user_name || '');
    stmts.markTaskStarted.run(taskGid, user_gid);
    res.json({ message: 'Timer started', task_gid: taskGid });
});

// Pause timer
app.post('/api/tasks/:taskGid/timer/pause', (req, res) => {
    const { taskGid } = req.params;
    const { user_gid } = req.body;
    if (!user_gid) return res.status(400).json({ error: 'user_gid is required' });

    const timer = stmts.getTimer.get(taskGid, user_gid);
    if (!timer) return res.status(404).json({ error: 'No timer found' });
    if (timer.status !== 'running') return res.status(400).json({ error: 'Timer is not running' });

    const lastResumed = new Date(timer.last_resumed_at + 'Z');
    const elapsed = Math.floor((Date.now() - lastResumed.getTime()) / 1000);
    const newAccumulated = (timer.accumulated_seconds || 0) + elapsed;

    stmts.pauseTimer.run(newAccumulated, taskGid, user_gid);
    res.json({ message: 'Timer paused', accumulated_seconds: newAccumulated, accumulated_formatted: formatDuration(newAccumulated) });
});

// Resume timer
app.post('/api/tasks/:taskGid/timer/resume', (req, res) => {
    const { taskGid } = req.params;
    const { user_gid } = req.body;
    if (!user_gid) return res.status(400).json({ error: 'user_gid is required' });

    const timer = stmts.getTimer.get(taskGid, user_gid);
    if (!timer) return res.status(404).json({ error: 'No timer found' });
    if (timer.status !== 'paused') return res.status(400).json({ error: 'Timer is not paused' });

    stmts.resumeTimer(taskGid, user_gid);
    res.json({ message: 'Timer resumed' });
});

// Stop timer
app.post('/api/tasks/:taskGid/timer/stop', (req, res) => {
    const { taskGid } = req.params;
    const { user_gid, notes } = req.body;
    if (!user_gid) return res.status(400).json({ error: 'user_gid is required' });

    const timer = stmts.getTimer.get(taskGid, user_gid);
    if (!timer) return res.status(404).json({ error: 'No timer found' });

    const totalSeconds = getTimerElapsed(timer);
    stmts.createEntry(taskGid, user_gid, timer.user_name, timer.started_at, totalSeconds, notes || '');
    stmts.deleteTimer.run(taskGid, user_gid);

    const grandTotal = stmts.getTotalTimeForTask.get(taskGid);

    res.json({
        message: 'Timer stopped',
        session_seconds: totalSeconds,
        session_formatted: formatDuration(totalSeconds),
        total_seconds: grandTotal.total_seconds,
        total_formatted: formatDuration(grandTotal.total_seconds)
    });
});

// =============================================================================
// Form: Manual time entry
// =============================================================================

app.get('/form', (req, res) => {
    res.json({
        template: 'form_metadata_v0',
        metadata: {
            title: 'Log Time Entry',
            submit_button_text: 'Log Time',
            on_submit_callback: `${CONFIG.baseUrl}/form/submit`
        },
        data: {
            fields: [
                { type: 'single_line_text', id: 'hours', name: 'Hours', is_required: false, placeholder: '0' },
                { type: 'single_line_text', id: 'minutes', name: 'Minutes', is_required: true, placeholder: '30' },
                { type: 'single_line_text', id: 'notes', name: 'Notes', is_required: false, placeholder: 'What did you work on?' }
            ]
        }
    });
});

app.post('/form/submit', async (req, res) => {
    const { task, user, values } = req.body;
    const hours = parseInt(values?.hours || '0', 10) || 0;
    const minutes = parseInt(values?.minutes || '0', 10) || 0;
    const notes = values?.notes || '';
    const totalSeconds = (hours * 3600) + (minutes * 60);

    if (totalSeconds <= 0) return res.json({ error: 'Enter a valid time' });

    let userName = '';
    try {
        const client = await getAsanaClient(user);
        if (client) {
            const userRes = await client.get(`/users/${user}`);
            userName = userRes.data.data.name || '';
        }
    } catch (e) { /* ignore */ }

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    stmts.createEntry(task, user, userName, now, totalSeconds, notes);
    await postTimeSummaryToTask(task, user, totalSeconds, 'Manual time logged');

    res.json({ message: `Logged ${formatDuration(totalSeconds)}${notes ? ' — ' + notes : ''}` });
});

// =============================================================================
// Webhook: Asana sends task change events here
// =============================================================================

// Asana webhook handshake — must echo X-Hook-Secret on first request
app.post('/webhooks', async (req, res) => {
    // Step 1: Handshake — Asana sends X-Hook-Secret header on first call
    const hookSecret = req.headers['x-hook-secret'];
    if (hookSecret) {
        console.log('[Webhook] Handshake received, confirming...');
        res.set('X-Hook-Secret', hookSecret);
        return res.sendStatus(200);
    }

    // Step 2: Process events
    const events = req.body?.events || [];
    res.sendStatus(200); // Respond immediately, process async

    for (const event of events) {
        // We only care about task changes on custom fields
        if (event.resource?.resource_type !== 'task') continue;
        if (event.action !== 'changed') continue;

        const taskGid = event.resource.gid;

        try {
            await handleStageChange(taskGid);
        } catch (err) {
            console.error(`[Webhook] Error processing task ${taskGid}:`, err.message);
        }
    }
});

// Core logic: read the task's Stage field and start/pause/resume/stop timer
async function handleStageChange(taskGid) {
    // Find any authenticated user to make the API call
    const anyToken = db.prepare('SELECT * FROM tokens LIMIT 1').get();
    if (!anyToken) {
        console.error('[Webhook] No authenticated users — cannot fetch task');
        return;
    }

    const client = await getAsanaClient(anyToken.user_gid);
    if (!client) return;

    // Fetch the task with custom fields and assignee
    const taskRes = await client.get(`/tasks/${taskGid}`, {
        params: { opt_fields: 'custom_fields,assignee,assignee.name,completed' }
    });
    const task = taskRes.data.data;

    // Find the Stage field value
    const stageField = task.custom_fields?.find(f => f.gid === CONFIG.stageFieldGid);
    if (!stageField) return; // Task doesn't have Stage field

    const stageValueGid = stageField.enum_value?.gid || null;
    const stageName = stageField.enum_value?.name || 'None';
    const userGid = task.assignee?.gid || 'system';
    const userName = task.assignee?.name || 'System';

    console.log(`[Webhook] Task ${taskGid} — Stage changed to: ${stageName} (${stageValueGid})`);

    const { stageValues } = CONFIG;

    // ── Stage = Planning or Development → START or RESUME ─────────────────
    if (stageValueGid === stageValues.planning || stageValueGid === stageValues.development) {
        const timer = stmts.getTimer.get(taskGid, userGid);

        if (timer && timer.status === 'paused') {
            // Resume paused timer
            stmts.resumeTimer(taskGid, userGid);
            await postTimeSummaryToTask(taskGid, userGid, timer.accumulated_seconds,
                `Timer auto-resumed — Stage: ${stageName}`);
            console.log(`[Webhook] Timer RESUMED for task ${taskGid}`);

        } else if (!timer) {
            // Start new timer (only if never started before)
            const alreadyStarted = stmts.hasTaskBeenStarted.get(taskGid, userGid);
            if (!alreadyStarted) {
                stmts.createTimer(taskGid, userGid, userName);
                stmts.markTaskStarted.run(taskGid, userGid);
                await postTimeSummaryToTask(taskGid, userGid, 0,
                    `Timer auto-started — Stage: ${stageName}`);
                console.log(`[Webhook] Timer STARTED for task ${taskGid}`);
            } else {
                console.log(`[Webhook] Task ${taskGid} already completed a timer session — skipping start`);
            }
        } else {
            console.log(`[Webhook] Timer already running for task ${taskGid} — no action`);
        }
    }

    // ── Stage = On Hold → PAUSE ───────────────────────────────────────────
    else if (stageValueGid === stageValues.onHold) {
        const timer = stmts.getTimer.get(taskGid, userGid);

        if (timer && timer.status === 'running') {
            const lastResumed = new Date(timer.last_resumed_at + 'Z');
            const elapsed = Math.floor((Date.now() - lastResumed.getTime()) / 1000);
            const newAccumulated = (timer.accumulated_seconds || 0) + elapsed;

            stmts.pauseTimer.run(newAccumulated, taskGid, userGid);
            await postTimeSummaryToTask(taskGid, userGid, newAccumulated,
                `Timer auto-paused — Stage: On Hold`);
            console.log(`[Webhook] Timer PAUSED for task ${taskGid} at ${formatDuration(newAccumulated)}`);
        } else {
            console.log(`[Webhook] No running timer to pause for task ${taskGid}`);
        }
    }

    // ── Stage = Completd → STOP ───────────────────────────────────────────
    else if (stageValueGid === stageValues.completed) {
        const timer = stmts.getTimer.get(taskGid, userGid);

        if (timer) {
            const totalSeconds = getTimerElapsed(timer);
            stmts.createEntry(taskGid, userGid, userName, timer.started_at, totalSeconds,
                'Auto-stopped — Stage: Completed');
            stmts.deleteTimer.run(taskGid, userGid);

            const grandTotal = stmts.getTotalTimeForTask.get(taskGid);
            await postTimeSummaryToTask(taskGid, userGid, grandTotal.total_seconds,
                `Timer auto-stopped — Stage: Completed | Session: ${formatDuration(totalSeconds)}`);
            console.log(`[Webhook] Timer STOPPED for task ${taskGid} — ${formatDuration(totalSeconds)}`);
        } else {
            console.log(`[Webhook] No timer to stop for task ${taskGid}`);
        }
    }
}

// =============================================================================
// Webhook Registration: Call this once to subscribe to task changes
// =============================================================================

app.post('/register-webhook', async (req, res) => {
    const { project_gid, user_gid } = req.body;

    if (!project_gid || !user_gid) {
        return res.status(400).json({ error: 'project_gid and user_gid are required' });
    }

    const client = await getAsanaClient(user_gid);
    if (!client) {
        return res.status(401).json({ error: 'No valid token for this user. Visit /auth first.' });
    }

    try {
        const response = await client.post('/webhooks', {
            data: {
                resource: project_gid,
                target: `${CONFIG.baseUrl}/webhooks`,
                filters: [
                    {
                        resource_type: 'task',
                        action: 'changed',
                        fields: ['custom_fields']
                    }
                ]
            }
        });

        console.log('[Webhook] Registered for project:', project_gid);
        res.json({
            message: 'Webhook registered',
            webhook: response.data.data
        });
    } catch (err) {
        console.error('[Webhook] Registration failed:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed to register webhook', details: err.response?.data || err.message });
    }
});

// List active webhooks
app.get('/webhooks/list', async (req, res) => {
    const { user_gid } = req.query;
    if (!user_gid) return res.status(400).json({ error: 'user_gid required' });

    const client = await getAsanaClient(user_gid);
    if (!client) return res.status(401).json({ error: 'No valid token' });

    try {
        const response = await client.get('/webhooks', {
            params: { workspace: CONFIG.workspaceGid }
        });
        res.json(response.data.data);
    } catch (err) {
        res.status(500).json({ error: err.response?.data || err.message });
    }
});

// =============================================================================
// Dashboard: Web UI to view all tracked time
// =============================================================================

app.get('/dashboard', (req, res) => {
    const { project, user, date_from, date_to } = req.query;

    // Get all time entries with optional filters
    let query = `
        SELECT
            te.task_gid,
            te.user_gid,
            te.user_name,
            te.started_at,
            te.stopped_at,
            te.duration_seconds,
            te.notes,
            te.created_at
        FROM time_entries te
        WHERE 1=1
    `;
    const params = [];

    if (user) {
        query += ' AND te.user_gid = ?';
        params.push(user);
    }
    if (date_from) {
        query += ' AND te.started_at >= ?';
        params.push(date_from);
    }
    if (date_to) {
        query += ' AND te.started_at <= ?';
        params.push(date_to);
    }
    query += ' ORDER BY te.created_at DESC';

    const entries = db.prepare(query).all(...params);

    // Group by task
    const taskMap = {};
    for (const entry of entries) {
        if (!taskMap[entry.task_gid]) {
            taskMap[entry.task_gid] = {
                task_gid: entry.task_gid,
                total_seconds: 0,
                entries: [],
                users: new Set()
            };
        }
        taskMap[entry.task_gid].total_seconds += entry.duration_seconds;
        taskMap[entry.task_gid].entries.push(entry);
        taskMap[entry.task_gid].users.add(entry.user_name || entry.user_gid);
    }

    // Get active timers
    const activeTimers = db.prepare('SELECT * FROM timers').all();

    // Summary stats
    const totalTracked = entries.reduce((sum, e) => sum + e.duration_seconds, 0);
    const uniqueTasks = Object.keys(taskMap).length;
    const uniqueUsers = [...new Set(entries.map(e => e.user_gid))].length;

    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Time Tracker Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f5f7; color: #1e1f21; }
        .header { background: #1e1f21; color: white; padding: 20px 32px; display: flex; justify-content: space-between; align-items: center; }
        .header h1 { font-size: 20px; font-weight: 600; }
        .header .refresh { color: #a2a0a2; text-decoration: none; font-size: 14px; }
        .header .refresh:hover { color: white; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; padding: 24px 32px; }
        .stat-card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
        .stat-card .label { font-size: 12px; color: #6d6e6f; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
        .stat-card .value { font-size: 28px; font-weight: 700; }
        .stat-card .value.green { color: #36b37e; }
        .stat-card .value.blue { color: #0052cc; }
        .stat-card .value.orange { color: #ff8b00; }
        .stat-card .value.purple { color: #6554c0; }
        .filters { padding: 0 32px 16px; display: flex; gap: 12px; align-items: center; }
        .filters input, .filters select { padding: 8px 12px; border: 1px solid #d1d1d1; border-radius: 6px; font-size: 14px; }
        .filters button { padding: 8px 16px; background: #0052cc; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; }
        .filters button:hover { background: #0065ff; }
        .section { padding: 0 32px 24px; }
        .section h2 { font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #1e1f21; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
        th { background: #f4f5f7; text-align: left; padding: 12px 16px; font-size: 12px; color: #6d6e6f; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
        td { padding: 12px 16px; border-top: 1px solid #eee; font-size: 14px; }
        tr:hover td { background: #f9f9fb; }
        .pill { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
        .pill.running { background: #e3fcef; color: #006644; }
        .pill.paused { background: #fff7e6; color: #974f0c; }
        .pill.stopped { background: #f4f5f7; color: #6d6e6f; }
        .time { font-family: 'SF Mono', Monaco, Consolas, monospace; font-weight: 600; }
        .task-link { color: #0052cc; text-decoration: none; }
        .task-link:hover { text-decoration: underline; }
        .active-section { margin-bottom: 24px; }
        .empty { text-align: center; padding: 40px; color: #6d6e6f; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Time Tracker Dashboard</h1>
        <a class="refresh" href="/dashboard${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}">Refresh</a>
    </div>

    <div class="stats">
        <div class="stat-card">
            <div class="label">Total Time Tracked</div>
            <div class="value green">${formatDuration(totalTracked)}</div>
        </div>
        <div class="stat-card">
            <div class="label">Tasks Tracked</div>
            <div class="value blue">${uniqueTasks}</div>
        </div>
        <div class="stat-card">
            <div class="label">Team Members</div>
            <div class="value purple">${uniqueUsers}</div>
        </div>
        <div class="stat-card">
            <div class="label">Active Timers</div>
            <div class="value orange">${activeTimers.length}</div>
        </div>
    </div>

    <div class="filters">
        <form method="GET" action="/dashboard" style="display:flex;gap:12px;align-items:center;">
            <input type="date" name="date_from" value="${date_from || ''}" placeholder="From date">
            <input type="date" name="date_to" value="${date_to || ''}" placeholder="To date">
            <button type="submit">Filter</button>
            <a href="/dashboard" style="font-size:14px;color:#6d6e6f;">Clear</a>
        </form>
    </div>

    ${activeTimers.length > 0 ? `
    <div class="section active-section">
        <h2>Active Timers</h2>
        <table>
            <tr><th>Task</th><th>User</th><th>Status</th><th>Running Time</th><th>Started</th></tr>
            ${activeTimers.map(t => {
                const elapsed = t.status === 'running'
                    ? (t.accumulated_seconds || 0) + Math.floor((Date.now() - new Date(t.started_at + 'Z').getTime()) / 1000)
                    : (t.accumulated_seconds || 0);
                return `<tr>
                    <td><a class="task-link" href="https://app.asana.com/0/0/${t.task_gid}" target="_blank">${t.task_gid}</a></td>
                    <td>${t.user_name || t.user_gid}</td>
                    <td><span class="pill ${t.status}">${t.status.charAt(0).toUpperCase() + t.status.slice(1)}</span></td>
                    <td class="time">${formatDuration(elapsed)}</td>
                    <td>${t.started_at}</td>
                </tr>`;
            }).join('')}
        </table>
    </div>` : ''}

    <div class="section">
        <h2>Time Log by Task</h2>
        ${Object.keys(taskMap).length === 0 ? '<div class="empty">No time entries yet</div>' : `
        <table>
            <tr><th>Task</th><th>Users</th><th>Sessions</th><th>Total Time</th><th>Last Entry</th></tr>
            ${Object.values(taskMap).sort((a, b) => b.total_seconds - a.total_seconds).map(t => `
                <tr>
                    <td><a class="task-link" href="https://app.asana.com/0/0/${t.task_gid}" target="_blank">${t.task_gid}</a></td>
                    <td>${[...t.users].join(', ')}</td>
                    <td>${t.entries.length}</td>
                    <td class="time">${formatDuration(t.total_seconds)}</td>
                    <td>${t.entries[0]?.created_at || '—'}</td>
                </tr>
            `).join('')}
        </table>`}
    </div>

    <div class="section">
        <h2>All Time Entries</h2>
        ${entries.length === 0 ? '<div class="empty">No time entries yet</div>' : `
        <table>
            <tr><th>Task</th><th>User</th><th>Duration</th><th>Started</th><th>Stopped</th><th>Notes</th></tr>
            ${entries.map(e => `
                <tr>
                    <td><a class="task-link" href="https://app.asana.com/0/0/${e.task_gid}" target="_blank">${e.task_gid}</a></td>
                    <td>${e.user_name || e.user_gid}</td>
                    <td class="time">${formatDuration(e.duration_seconds)}</td>
                    <td>${e.started_at}</td>
                    <td>${e.stopped_at || '—'}</td>
                    <td>${e.notes || '—'}</td>
                </tr>
            `).join('')}
        </table>`}
    </div>

    <script>
        // Auto-refresh active timers every 30 seconds
        ${activeTimers.length > 0 ? 'setTimeout(() => location.reload(), 30000);' : ''}
    </script>
</body>
</html>
    `);
});

// Dashboard API: JSON version for programmatic access
app.get('/api/dashboard', (req, res) => {
    const entries = db.prepare('SELECT * FROM time_entries ORDER BY created_at DESC').all();
    const activeTimers = db.prepare('SELECT * FROM timers').all();
    const totalTracked = entries.reduce((sum, e) => sum + e.duration_seconds, 0);

    // Group by task
    const byTask = {};
    for (const e of entries) {
        if (!byTask[e.task_gid]) byTask[e.task_gid] = { total_seconds: 0, entries: 0 };
        byTask[e.task_gid].total_seconds += e.duration_seconds;
        byTask[e.task_gid].entries++;
    }

    // Group by user
    const byUser = {};
    for (const e of entries) {
        const key = e.user_name || e.user_gid;
        if (!byUser[key]) byUser[key] = { total_seconds: 0, entries: 0 };
        byUser[key].total_seconds += e.duration_seconds;
        byUser[key].entries++;
    }

    res.json({
        summary: {
            total_seconds: totalTracked,
            total_formatted: formatDuration(totalTracked),
            total_tasks: Object.keys(byTask).length,
            total_users: Object.keys(byUser).length,
            active_timers: activeTimers.length
        },
        by_task: byTask,
        by_user: byUser,
        active_timers: activeTimers,
        recent_entries: entries.slice(0, 50)
    });
});

// =============================================================================
// Health & Handshake
// =============================================================================

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/handshake', (req, res) => {
    const { data } = req.body;
    if (data && data.type === 'app_components_created') {
        return res.json({ data: {} });
    }
    res.json({});
});

app.use('/icons', express.static(path.join(__dirname, 'icons')));

// =============================================================================
// Start Server
// =============================================================================

app.listen(CONFIG.port, () => {
    console.log(`\nAsana Time Tracker running at ${CONFIG.baseUrl}`);
    console.log(`\nManual Actions:`);
    console.log(`  POST /action  { action: "start|pause|resume|stop", task: "gid", user: "gid" }`);
    console.log(`\nAutomatic (via webhook):`);
    console.log(`  Stage → Planning/Development  = auto START or RESUME`);
    console.log(`  Stage → On Hold               = auto PAUSE`);
    console.log(`  Stage → Completd              = auto STOP`);
    console.log(`\nEndpoints:`);
    console.log(`  Dashboard:         ${CONFIG.baseUrl}/dashboard`);
    console.log(`  Auth:              ${CONFIG.baseUrl}/auth`);
    console.log(`  Widget:            ${CONFIG.baseUrl}/widget?task=GID&user=GID`);
    console.log(`  Setup field:       POST ${CONFIG.baseUrl}/setup/create-time-field`);
    console.log(`  Register webhook:  POST ${CONFIG.baseUrl}/register-webhook`);
    console.log(`  List webhooks:     GET ${CONFIG.baseUrl}/webhooks/list?user_gid=GID`);
    console.log(`  Health:            ${CONFIG.baseUrl}/health`);
});
