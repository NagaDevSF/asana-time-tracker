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
    port: process.env.PORT || 3000,
    baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    asanaApiBase: 'https://app.asana.com/api/1.0',
    asanaPat: process.env.ASANA_PAT,
    workspaceGid: process.env.ASANA_WORKSPACE_GID || '1207860012563297',
    defaultUserGid: process.env.ASANA_USER_GID || '1210859739324139',
    stageFieldGid: '1211547841344722',
    stageValues: {
        planning:    '1211547841344725',
        development: '1211547841344726',
        onHold:      '1211547841344727',
        completed:   '1211547841344729'
    },
    timeTrackedFieldGid: process.env.TIME_TRACKED_FIELD_GID || null
};

// =============================================================================
// Asana API Client (uses PAT — no OAuth needed)
// =============================================================================

const asana = axios.create({
    baseURL: CONFIG.asanaApiBase,
    headers: { 'Authorization': `Bearer ${CONFIG.asanaPat}` }
});

// =============================================================================
// Database Setup
// =============================================================================

const dbPath = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'timetracker.db')
    : path.join(__dirname, 'timetracker.db');
const db = new Database(dbPath);

db.exec(`
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
    createTimer: function(taskGid, userGid, userName) {
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        return db.prepare(`
            INSERT INTO timers (task_gid, user_gid, user_name, status, started_at, last_resumed_at, accumulated_seconds)
            VALUES (?, ?, ?, 'running', ?, ?, 0)
        `).run(taskGid, userGid, userName, now, now);
    },
    getTimer: db.prepare('SELECT * FROM timers WHERE task_gid = ? AND user_gid = ?'),
    getTimerForTask: db.prepare('SELECT * FROM timers WHERE task_gid = ?'),
    pauseTimer: db.prepare('UPDATE timers SET status = ?, accumulated_seconds = ? WHERE task_gid = ? AND user_gid = ?'),
    resumeTimer: function(taskGid, userGid) {
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        return db.prepare('UPDATE timers SET status = ?, last_resumed_at = ? WHERE task_gid = ? AND user_gid = ?')
            .run('running', now, taskGid, userGid);
    },
    deleteTimer: db.prepare('DELETE FROM timers WHERE task_gid = ? AND user_gid = ?'),

    markTaskStarted: db.prepare('INSERT OR IGNORE INTO task_started (task_gid, user_gid) VALUES (?, ?)'),
    hasTaskBeenStarted: db.prepare('SELECT 1 FROM task_started WHERE task_gid = ? AND user_gid = ?'),

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
// Helpers
// =============================================================================

function formatDuration(totalSeconds) {
    if (totalSeconds <= 0) return '0s';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function getTimerElapsed(timer) {
    if (!timer) return 0;
    let total = timer.accumulated_seconds || 0;
    if (timer.status === 'running') {
        const lastResumed = new Date(timer.last_resumed_at + 'Z');
        total += Math.floor((Date.now() - lastResumed.getTime()) / 1000);
    }
    return total;
}

async function postTimeSummaryToTask(taskGid, totalSeconds, action) {
    if (!CONFIG.asanaPat) return;
    try {
        await asana.post(`/tasks/${taskGid}/stories`, {
            data: { text: `[Time Tracker] ${action} — Total time: ${formatDuration(totalSeconds)}` }
        });
        if (CONFIG.timeTrackedFieldGid) {
            await asana.put(`/tasks/${taskGid}`, {
                data: { custom_fields: { [CONFIG.timeTrackedFieldGid]: formatDuration(totalSeconds) } }
            });
        }
    } catch (err) {
        console.error('Failed to update Asana:', err.message);
    }
}

// =============================================================================
// Widget
// =============================================================================

app.get('/widget', (req, res) => {
    const taskGid = req.query.task;
    const userGid = req.query.user || CONFIG.defaultUserGid;
    if (!taskGid) return res.json({ template: 'summary_with_details_v0', metadata: { title: 'Time Tracker', subtitle: 'No task' }, data: { footer: '' } });

    const timer = stmts.getTimer.get(taskGid, userGid) || stmts.getTimerForTask.get(taskGid);
    const hasStarted = stmts.hasTaskBeenStarted.get(taskGid, userGid);
    const completedTime = stmts.getTotalTimeForTask.get(taskGid);
    const entries = stmts.getEntriesForTask.all(taskGid);
    const timerElapsed = getTimerElapsed(timer);
    const totalSeconds = completedTime.total_seconds + timerElapsed;

    let statusText, statusColor;
    if (!timer && !hasStarted) { statusText = 'Not Started'; statusColor = 'grey'; }
    else if (timer?.status === 'running') { statusText = 'Running'; statusColor = 'green'; }
    else if (timer?.status === 'paused') { statusText = `Paused (${formatDuration(timerElapsed)})`; statusColor = 'yellow'; }
    else { statusText = 'Stopped'; statusColor = 'grey'; }

    const fields = [
        { name: 'Timer', type: 'pill', text: statusText, color: statusColor },
        { name: 'Current Session', type: 'text_with_icon', text: timer ? formatDuration(timerElapsed) : '—' },
        { name: 'Total Time Logged', type: 'text_with_icon', text: formatDuration(totalSeconds) },
        { name: 'Completed Sessions', type: 'text_with_icon', text: `${entries.length}` }
    ];

    entries.slice(0, 3).forEach((entry, i) => {
        fields.push({ name: `Session ${i + 1}`, type: 'text_with_icon',
            text: `${formatDuration(entry.duration_seconds)} — ${entry.user_name || 'User'}${entry.notes ? ' (' + entry.notes + ')' : ''}` });
    });

    res.json({
        template: 'summary_with_details_v0',
        metadata: { title: 'Time Tracker', subtitle: timer?.status === 'running' ? `Running: ${formatDuration(timerElapsed)}` : formatDuration(totalSeconds), num_comments: entries.length },
        data: { title: `Total: ${formatDuration(totalSeconds)}`, fields, footer: statusText }
    });
});

// =============================================================================
// Timer Actions: Start / Pause / Resume / Stop
// =============================================================================

app.post('/action', async (req, res) => {
    const { action, task, user } = req.body;
    const taskGid = task;
    const userGid = user || CONFIG.defaultUserGid;
    if (!taskGid) return res.json({ error: 'Missing task' });

    let userName = '';
    try { const r = await asana.get(`/users/${userGid}`); userName = r.data.data.name || ''; } catch (e) { /* ignore */ }

    if (action === 'start') {
        const alreadyStarted = stmts.hasTaskBeenStarted.get(taskGid, userGid);
        if (alreadyStarted) return res.json({ error: 'Timer already started on this task. You cannot start twice.' });
        const existing = stmts.getTimer.get(taskGid, userGid);
        if (existing) return res.json({ error: 'Timer already exists on this task.' });
        stmts.createTimer(taskGid, userGid, userName);
        stmts.markTaskStarted.run(taskGid, userGid);
        await postTimeSummaryToTask(taskGid, 0, 'Timer started');
        return res.json({ message: 'Timer started' });
    }

    if (action === 'pause') {
        const timer = stmts.getTimer.get(taskGid, userGid);
        if (!timer) return res.json({ error: 'No timer found.' });
        if (timer.status !== 'running') return res.json({ error: 'Timer is not running.' });
        const lastResumed = new Date(timer.last_resumed_at + 'Z');
        const elapsed = Math.floor((Date.now() - lastResumed.getTime()) / 1000);
        const newAccumulated = (timer.accumulated_seconds || 0) + elapsed;
        stmts.pauseTimer.run('paused', newAccumulated, taskGid, userGid);
        await postTimeSummaryToTask(taskGid, newAccumulated, 'Timer paused');
        return res.json({ message: `Timer paused at ${formatDuration(newAccumulated)}` });
    }

    if (action === 'resume') {
        const timer = stmts.getTimer.get(taskGid, userGid);
        if (!timer) return res.json({ error: 'No timer found.' });
        if (timer.status !== 'paused') return res.json({ error: 'Timer is not paused.' });
        stmts.resumeTimer(taskGid, userGid);
        await postTimeSummaryToTask(taskGid, timer.accumulated_seconds, 'Timer resumed');
        return res.json({ message: 'Timer resumed' });
    }

    if (action === 'stop') {
        const timer = stmts.getTimer.get(taskGid, userGid);
        if (!timer) return res.json({ error: 'No timer found.' });
        const totalSeconds = getTimerElapsed(timer);
        stmts.createEntry(taskGid, userGid, userName, timer.started_at, totalSeconds, '');
        stmts.deleteTimer.run(taskGid, userGid);
        const grandTotal = stmts.getTotalTimeForTask.get(taskGid);
        await postTimeSummaryToTask(taskGid, grandTotal.total_seconds, `Timer stopped — Session: ${formatDuration(totalSeconds)}`);
        return res.json({ message: `Timer stopped. Session: ${formatDuration(totalSeconds)}. Total: ${formatDuration(grandTotal.total_seconds)}` });
    }

    res.json({ error: 'Unknown action. Use: start, pause, resume, stop' });
});

app.post('/widget/action', (req, res) => { req.url = '/action'; app.handle(req, res); });

// =============================================================================
// REST API
// =============================================================================

app.get('/api/tasks/:taskGid/time', (req, res) => {
    const { taskGid } = req.params;
    const userGid = req.query.user_gid || CONFIG.defaultUserGid;
    const timer = stmts.getTimer.get(taskGid, userGid) || stmts.getTimerForTask.get(taskGid);
    const hasStarted = stmts.hasTaskBeenStarted.get(taskGid, userGid);
    const completedTime = stmts.getTotalTimeForTask.get(taskGid);
    const entries = stmts.getEntriesForTask.all(taskGid);
    const timerElapsed = getTimerElapsed(timer);
    const totalSeconds = completedTime.total_seconds + timerElapsed;
    let availableActions = [];
    if (!timer && !hasStarted) availableActions = ['start'];
    else if (timer?.status === 'running') availableActions = ['pause', 'stop'];
    else if (timer?.status === 'paused') availableActions = ['resume', 'stop'];
    res.json({ task_gid: taskGid, timer_status: timer ? timer.status : (hasStarted ? 'stopped' : 'not_started'), can_start: !hasStarted && !timer, current_session_seconds: timerElapsed, current_session_formatted: formatDuration(timerElapsed), total_seconds: totalSeconds, total_formatted: formatDuration(totalSeconds), available_actions: availableActions, entries });
});

app.post('/api/tasks/:taskGid/timer/start', (req, res) => {
    const { taskGid } = req.params; const { user_gid, user_name } = req.body;
    const userGid = user_gid || CONFIG.defaultUserGid;
    if (stmts.hasTaskBeenStarted.get(taskGid, userGid)) return res.status(409).json({ error: 'Cannot start twice.' });
    if (stmts.getTimer.get(taskGid, userGid)) return res.status(409).json({ error: 'Timer already exists.' });
    stmts.createTimer(taskGid, userGid, user_name || ''); stmts.markTaskStarted.run(taskGid, userGid);
    res.json({ message: 'Timer started', task_gid: taskGid });
});

app.post('/api/tasks/:taskGid/timer/pause', (req, res) => {
    const { taskGid } = req.params; const userGid = req.body.user_gid || CONFIG.defaultUserGid;
    const timer = stmts.getTimer.get(taskGid, userGid);
    if (!timer) return res.status(404).json({ error: 'No timer' });
    if (timer.status !== 'running') return res.status(400).json({ error: 'Not running' });
    const elapsed = Math.floor((Date.now() - new Date(timer.last_resumed_at + 'Z').getTime()) / 1000);
    const newAcc = (timer.accumulated_seconds || 0) + elapsed;
    stmts.pauseTimer.run('paused', newAcc, taskGid, userGid);
    res.json({ message: 'Paused', accumulated_formatted: formatDuration(newAcc) });
});

app.post('/api/tasks/:taskGid/timer/resume', (req, res) => {
    const { taskGid } = req.params; const userGid = req.body.user_gid || CONFIG.defaultUserGid;
    const timer = stmts.getTimer.get(taskGid, userGid);
    if (!timer) return res.status(404).json({ error: 'No timer' });
    if (timer.status !== 'paused') return res.status(400).json({ error: 'Not paused' });
    stmts.resumeTimer(taskGid, userGid);
    res.json({ message: 'Resumed' });
});

app.post('/api/tasks/:taskGid/timer/stop', (req, res) => {
    const { taskGid } = req.params; const userGid = req.body.user_gid || CONFIG.defaultUserGid;
    const timer = stmts.getTimer.get(taskGid, userGid);
    if (!timer) return res.status(404).json({ error: 'No timer' });
    const totalSec = getTimerElapsed(timer);
    stmts.createEntry(taskGid, userGid, timer.user_name, timer.started_at, totalSec, req.body.notes || '');
    stmts.deleteTimer.run(taskGid, userGid);
    const grand = stmts.getTotalTimeForTask.get(taskGid);
    res.json({ message: 'Stopped', session_formatted: formatDuration(totalSec), total_formatted: formatDuration(grand.total_seconds) });
});

// =============================================================================
// Form: Manual time entry
// =============================================================================

app.get('/form', (req, res) => {
    res.json({ template: 'form_metadata_v0', metadata: { title: 'Log Time Entry', submit_button_text: 'Log Time', on_submit_callback: `${CONFIG.baseUrl}/form/submit` },
        data: { fields: [
            { type: 'single_line_text', id: 'hours', name: 'Hours', is_required: false, placeholder: '0' },
            { type: 'single_line_text', id: 'minutes', name: 'Minutes', is_required: true, placeholder: '30' },
            { type: 'single_line_text', id: 'notes', name: 'Notes', is_required: false, placeholder: 'What did you work on?' }
        ] }
    });
});

app.post('/form/submit', async (req, res) => {
    const { task, user, values } = req.body;
    const userGid = user || CONFIG.defaultUserGid;
    const hours = parseInt(values?.hours || '0', 10) || 0;
    const minutes = parseInt(values?.minutes || '0', 10) || 0;
    const notes = values?.notes || '';
    const totalSeconds = (hours * 3600) + (minutes * 60);
    if (totalSeconds <= 0) return res.json({ error: 'Enter a valid time' });
    let userName = '';
    try { const r = await asana.get(`/users/${userGid}`); userName = r.data.data.name || ''; } catch (e) { /* ignore */ }
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    stmts.createEntry(task, userGid, userName, now, totalSeconds, notes);
    await postTimeSummaryToTask(task, totalSeconds, 'Manual time logged');
    res.json({ message: `Logged ${formatDuration(totalSeconds)}${notes ? ' — ' + notes : ''}` });
});

// =============================================================================
// Webhook: Auto-timer based on Stage field changes
// =============================================================================

app.post('/webhooks', async (req, res) => {
    const hookSecret = req.headers['x-hook-secret'];
    if (hookSecret) { res.set('X-Hook-Secret', hookSecret); return res.sendStatus(200); }

    const events = req.body?.events || [];
    res.sendStatus(200);

    for (const event of events) {
        if (event.resource?.resource_type !== 'task' || event.action !== 'changed') continue;
        try { await handleStageChange(event.resource.gid); }
        catch (err) { console.error(`[Webhook] Error for task ${event.resource.gid}:`, err.message); }
    }
});

async function handleStageChange(taskGid) {
    if (!CONFIG.asanaPat) return;

    const taskRes = await asana.get(`/tasks/${taskGid}`, { params: { opt_fields: 'custom_fields,assignee,assignee.name,completed' } });
    const task = taskRes.data.data;
    const stageField = task.custom_fields?.find(f => f.gid === CONFIG.stageFieldGid);
    if (!stageField) return;

    const stageGid = stageField.enum_value?.gid || null;
    const stageName = stageField.enum_value?.name || 'None';
    const userGid = task.assignee?.gid || CONFIG.defaultUserGid;
    const userName = task.assignee?.name || 'System';
    const { stageValues } = CONFIG;

    console.log(`[Webhook] Task ${taskGid} — Stage: ${stageName}`);

    // Planning / Development → START or RESUME
    if (stageGid === stageValues.planning || stageGid === stageValues.development) {
        const timer = stmts.getTimer.get(taskGid, userGid);
        if (timer?.status === 'paused') {
            stmts.resumeTimer(taskGid, userGid);
            await postTimeSummaryToTask(taskGid, timer.accumulated_seconds, `Timer auto-resumed — Stage: ${stageName}`);
            console.log(`[Webhook] RESUMED ${taskGid}`);
        } else if (!timer) {
            const alreadyStarted = stmts.hasTaskBeenStarted.get(taskGid, userGid);
            if (!alreadyStarted) {
                stmts.createTimer(taskGid, userGid, userName);
                stmts.markTaskStarted.run(taskGid, userGid);
                await postTimeSummaryToTask(taskGid, 0, `Timer auto-started — Stage: ${stageName}`);
                console.log(`[Webhook] STARTED ${taskGid}`);
            }
        }
    }
    // On Hold → PAUSE
    else if (stageGid === stageValues.onHold) {
        const timer = stmts.getTimer.get(taskGid, userGid);
        if (timer?.status === 'running') {
            const elapsed = Math.floor((Date.now() - new Date(timer.last_resumed_at + 'Z').getTime()) / 1000);
            const newAcc = (timer.accumulated_seconds || 0) + elapsed;
            stmts.pauseTimer.run('paused', newAcc, taskGid, userGid);
            await postTimeSummaryToTask(taskGid, newAcc, 'Timer auto-paused — Stage: On Hold');
            console.log(`[Webhook] PAUSED ${taskGid} at ${formatDuration(newAcc)}`);
        }
    }
    // Completd → STOP
    else if (stageGid === stageValues.completed) {
        const timer = stmts.getTimer.get(taskGid, userGid);
        if (timer) {
            const totalSec = getTimerElapsed(timer);
            stmts.createEntry(taskGid, userGid, userName, timer.started_at, totalSec, 'Auto-stopped — Stage: Completed');
            stmts.deleteTimer.run(taskGid, userGid);
            const grand = stmts.getTotalTimeForTask.get(taskGid);
            await postTimeSummaryToTask(taskGid, grand.total_seconds, `Timer auto-stopped — Stage: Completed | Session: ${formatDuration(totalSec)}`);
            console.log(`[Webhook] STOPPED ${taskGid} — ${formatDuration(totalSec)}`);
        }
    }
}

// =============================================================================
// Webhook Registration
// =============================================================================

app.post('/register-webhook', async (req, res) => {
    const { project_gid } = req.body;
    if (!project_gid) return res.status(400).json({ error: 'project_gid required' });
    if (!CONFIG.asanaPat) return res.status(401).json({ error: 'ASANA_PAT not configured' });

    try {
        const response = await asana.post('/webhooks', {
            data: { resource: project_gid, target: `${CONFIG.baseUrl}/webhooks`, filters: [{ resource_type: 'task', action: 'changed', fields: ['custom_fields'] }] }
        });
        console.log('[Webhook] Registered for project:', project_gid);
        res.json({ message: 'Webhook registered', webhook: response.data.data });
    } catch (err) {
        console.error('[Webhook] Registration failed:', err.response?.data || err.message);
        res.status(500).json({ error: 'Failed', details: err.response?.data || err.message });
    }
});

app.get('/webhooks/list', async (req, res) => {
    if (!CONFIG.asanaPat) return res.status(401).json({ error: 'ASANA_PAT not configured' });
    try {
        const response = await asana.get('/webhooks', { params: { workspace: CONFIG.workspaceGid } });
        res.json(response.data.data);
    } catch (err) { res.status(500).json({ error: err.response?.data || err.message }); }
});

// =============================================================================
// Setup: Create "Time Tracked" custom field
// =============================================================================

app.post('/setup/create-time-field', async (req, res) => {
    const { project_gids } = req.body;
    if (!CONFIG.asanaPat) return res.status(401).json({ error: 'ASANA_PAT not configured' });

    try {
        const fieldRes = await asana.post('/custom_fields', {
            data: { workspace: CONFIG.workspaceGid, name: 'Time Tracked', resource_subtype: 'text', description: 'Auto-updated by Time Tracker. Shows total time worked.' }
        });
        const fieldGid = fieldRes.data.data.gid;
        CONFIG.timeTrackedFieldGid = fieldGid;

        const added = [];
        if (project_gids) {
            for (const pid of project_gids) {
                try { await asana.post(`/projects/${pid}/addCustomFieldSetting`, { data: { custom_field: fieldGid } }); added.push(pid); }
                catch (e) { console.error(`Failed to add field to project ${pid}:`, e.message); }
            }
        }
        res.json({ message: 'Created', field_gid: fieldGid, added_to_projects: added, next: `Set TIME_TRACKED_FIELD_GID=${fieldGid} in env vars` });
    } catch (err) { res.status(500).json({ error: err.response?.data || err.message }); }
});

// =============================================================================
// Dashboard
// =============================================================================

app.get('/dashboard', (req, res) => {
    const { date_from, date_to } = req.query;
    let query = 'SELECT * FROM time_entries WHERE 1=1';
    const params = [];
    if (date_from) { query += ' AND started_at >= ?'; params.push(date_from); }
    if (date_to) { query += ' AND started_at <= ?'; params.push(date_to); }
    query += ' ORDER BY created_at DESC';
    const entries = db.prepare(query).all(...params);
    const activeTimers = db.prepare('SELECT * FROM timers').all();
    const totalTracked = entries.reduce((sum, e) => sum + e.duration_seconds, 0);

    const taskMap = {};
    for (const e of entries) {
        if (!taskMap[e.task_gid]) taskMap[e.task_gid] = { task_gid: e.task_gid, total_seconds: 0, entries: [], users: new Set() };
        taskMap[e.task_gid].total_seconds += e.duration_seconds;
        taskMap[e.task_gid].entries.push(e);
        taskMap[e.task_gid].users.add(e.user_name || e.user_gid);
    }
    const uniqueTasks = Object.keys(taskMap).length;
    const uniqueUsers = [...new Set(entries.map(e => e.user_gid))].length;

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Time Tracker Dashboard</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f5f7;color:#1e1f21}
.header{background:#1e1f21;color:#fff;padding:20px 32px;display:flex;justify-content:space-between;align-items:center}.header h1{font-size:20px}.header a{color:#a2a0a2;text-decoration:none;font-size:14px}.header a:hover{color:#fff}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:24px 32px}.stat-card{background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}.stat-card .label{font-size:12px;color:#6d6e6f;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}.stat-card .value{font-size:28px;font-weight:700}
.green{color:#36b37e}.blue{color:#0052cc}.orange{color:#ff8b00}.purple{color:#6554c0}
.filters{padding:0 32px 16px;display:flex;gap:12px}.filters input{padding:8px 12px;border:1px solid #d1d1d1;border-radius:6px;font-size:14px}.filters button{padding:8px 16px;background:#0052cc;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px}.filters button:hover{background:#0065ff}
.section{padding:0 32px 24px}.section h2{font-size:16px;font-weight:600;margin-bottom:12px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}th{background:#f4f5f7;text-align:left;padding:12px 16px;font-size:12px;color:#6d6e6f;text-transform:uppercase;letter-spacing:.5px;font-weight:600}td{padding:12px 16px;border-top:1px solid #eee;font-size:14px}tr:hover td{background:#f9f9fb}
.pill{display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600}.running{background:#e3fcef;color:#006644}.paused{background:#fff7e6;color:#974f0c}.stopped{background:#f4f5f7;color:#6d6e6f}
.time{font-family:'SF Mono',Monaco,Consolas,monospace;font-weight:600}.task-link{color:#0052cc;text-decoration:none}.task-link:hover{text-decoration:underline}.empty{text-align:center;padding:40px;color:#6d6e6f}
</style></head><body>
<div class="header"><h1>Time Tracker Dashboard</h1><a href="/dashboard">Refresh</a></div>
<div class="stats">
<div class="stat-card"><div class="label">Total Time</div><div class="value green">${formatDuration(totalTracked)}</div></div>
<div class="stat-card"><div class="label">Tasks</div><div class="value blue">${uniqueTasks}</div></div>
<div class="stat-card"><div class="label">Team</div><div class="value purple">${uniqueUsers}</div></div>
<div class="stat-card"><div class="label">Active Timers</div><div class="value orange">${activeTimers.length}</div></div>
</div>
<div class="filters"><form method="GET" action="/dashboard" style="display:flex;gap:12px"><input type="date" name="date_from" value="${date_from||''}"><input type="date" name="date_to" value="${date_to||''}"><button type="submit">Filter</button><a href="/dashboard" style="font-size:14px;color:#6d6e6f;padding:8px">Clear</a></form></div>
${activeTimers.length > 0 ? `<div class="section"><h2>Active Timers</h2><table><tr><th>Task</th><th>User</th><th>Status</th><th>Time</th><th>Started</th></tr>${activeTimers.map(t => {
    const el = t.status==='running' ? (t.accumulated_seconds||0)+Math.floor((Date.now()-new Date(t.started_at+'Z').getTime())/1000) : (t.accumulated_seconds||0);
    return `<tr><td><a class="task-link" href="https://app.asana.com/0/0/${t.task_gid}" target="_blank">${t.task_gid}</a></td><td>${t.user_name||t.user_gid}</td><td><span class="pill ${t.status}">${t.status}</span></td><td class="time">${formatDuration(el)}</td><td>${t.started_at}</td></tr>`;
}).join('')}</table></div>` : ''}
<div class="section"><h2>Time by Task</h2>${uniqueTasks===0?'<div class="empty">No entries yet</div>':`<table><tr><th>Task</th><th>Users</th><th>Sessions</th><th>Total</th><th>Last</th></tr>${Object.values(taskMap).sort((a,b)=>b.total_seconds-a.total_seconds).map(t=>`<tr><td><a class="task-link" href="https://app.asana.com/0/0/${t.task_gid}" target="_blank">${t.task_gid}</a></td><td>${[...t.users].join(', ')}</td><td>${t.entries.length}</td><td class="time">${formatDuration(t.total_seconds)}</td><td>${t.entries[0]?.created_at||'—'}</td></tr>`).join('')}</table>`}</div>
<div class="section"><h2>All Entries</h2>${entries.length===0?'<div class="empty">No entries yet</div>':`<table><tr><th>Task</th><th>User</th><th>Duration</th><th>Started</th><th>Stopped</th><th>Notes</th></tr>${entries.map(e=>`<tr><td><a class="task-link" href="https://app.asana.com/0/0/${e.task_gid}" target="_blank">${e.task_gid}</a></td><td>${e.user_name||e.user_gid}</td><td class="time">${formatDuration(e.duration_seconds)}</td><td>${e.started_at}</td><td>${e.stopped_at||'—'}</td><td>${e.notes||'—'}</td></tr>`).join('')}</table>`}</div>
${activeTimers.length>0?'<script>setTimeout(()=>location.reload(),30000)</script>':''}
</body></html>`);
});

app.get('/api/dashboard', (req, res) => {
    const entries = db.prepare('SELECT * FROM time_entries ORDER BY created_at DESC').all();
    const activeTimers = db.prepare('SELECT * FROM timers').all();
    const total = entries.reduce((s, e) => s + e.duration_seconds, 0);
    const byTask = {}, byUser = {};
    for (const e of entries) { if (!byTask[e.task_gid]) byTask[e.task_gid]={total_seconds:0,entries:0}; byTask[e.task_gid].total_seconds+=e.duration_seconds; byTask[e.task_gid].entries++; }
    for (const e of entries) { const k=e.user_name||e.user_gid; if(!byUser[k]) byUser[k]={total_seconds:0,entries:0}; byUser[k].total_seconds+=e.duration_seconds; byUser[k].entries++; }
    res.json({ summary: { total_seconds: total, total_formatted: formatDuration(total), total_tasks: Object.keys(byTask).length, total_users: Object.keys(byUser).length, active_timers: activeTimers.length }, by_task: byTask, by_user: byUser, active_timers: activeTimers, recent_entries: entries.slice(0, 50) });
});

// =============================================================================
// Health & Handshake
// =============================================================================

app.get('/health', (req, res) => { res.json({ status: 'ok', pat_configured: !!CONFIG.asanaPat, timestamp: new Date().toISOString() }); });
app.post('/handshake', (req, res) => { res.json({}); });
app.use('/icons', express.static(path.join(__dirname, 'icons')));

app.listen(CONFIG.port, () => {
    console.log(`\nAsana Time Tracker running at ${CONFIG.baseUrl}`);
    console.log(`PAT configured: ${!!CONFIG.asanaPat}`);
    console.log(`\nAuto-timer rules:`);
    console.log(`  Stage → Planning/Development = START or RESUME`);
    console.log(`  Stage → On Hold             = PAUSE`);
    console.log(`  Stage → Completd            = STOP`);
    console.log(`\nDashboard: ${CONFIG.baseUrl}/dashboard`);
});
