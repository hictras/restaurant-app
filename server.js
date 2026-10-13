const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure Web Push VAPID keys
const vapidKeys = webpush.generateVAPIDKeys();
webpush.setVapidDetails(
    'mailto:admin@lastballoon.net',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

const tablePushSubscriptions = {};

app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/subscribe-push', (req, res) => {
    const { restaurant, tableNumber, subscription } = req.body;
    const resto = restaurant || 'Default';
    const tKey = String(tableNumber);
    const sessionKey = `${resto}_${tKey}`;

    if (!tablePushSubscriptions[sessionKey]) tablePushSubscriptions[sessionKey] = [];
    if (!tablePushSubscriptions[sessionKey].some(sub => sub.endpoint === subscription.endpoint)) {
        tablePushSubscriptions[sessionKey].push(subscription);
    }
    res.status(201).json({ success: true });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

app.get('/menu.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

// Initialize SQLite Database
const dbPath = path.join(__dirname, 'data', 'restaurant.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS tables_state (
        restaurant TEXT,
        table_number TEXT,
        is_open INTEGER,
        can_order INTEGER,
        status TEXT,
        PRIMARY KEY (restaurant, table_number)
    );

    CREATE TABLE IF NOT EXISTS table_requests (
        restaurant TEXT,
        table_number TEXT,
        requested INTEGER,
        PRIMARY KEY (restaurant, table_number)
    );

    CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        restaurant TEXT,
        table_number TEXT,
        items TEXT,
        total REAL,
        kitchen_status TEXT,
        bill_status TEXT,
        date TEXT,
        timestamp TEXT
    );

    CREATE TABLE IF NOT EXISTS paid_history (
        order_id TEXT PRIMARY KEY,
        restaurant TEXT,
        table_number TEXT,
        items TEXT,
        total REAL,
        kitchen_status TEXT,
        bill_status TEXT,
        date TEXT,
        timestamp TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        restaurant TEXT,
        table_number TEXT,
        start_time INTEGER,
        lifetime_minutes INTEGER DEFAULT 15
    );
`);

const restaurantsDir = path.join(__dirname, 'restaurants');
if (!fs.existsSync(restaurantsDir)) fs.mkdirSync(restaurantsDir);

const tableSockets = {};

function getAppState() {
    const tables = {};
    const rows = db.prepare('SELECT * FROM tables_state').all();
    rows.forEach(r => {
        if (!tables[r.restaurant]) tables[r.restaurant] = {};
        tables[r.restaurant][r.table_number] = {
            isOpen: !!r.is_open,
            canOrder: !!r.can_order,
            status: r.status
        };
    });

    const activeSessions = {};
    const sessionRows = db.prepare('SELECT restaurant, table_number, start_time, lifetime_minutes FROM sessions').all();
    const now = Date.now();
    sessionRows.forEach(s => {
        const lifetimeMs = (s.lifetime_minutes || 15) * 60 * 1000;
        if (now - s.start_time <= lifetimeMs) {
            if (!activeSessions[s.restaurant]) activeSessions[s.restaurant] = {};
            const sessionKey = `${s.restaurant}_${s.table_number}`;
            const activeCount = (tableSockets[sessionKey] && tableSockets[sessionKey].size > 0)
                ? tableSockets[sessionKey].size
                : 1;

            activeSessions[s.restaurant][s.table_number] = activeCount;
        }
    });

    const tableRequests = {};
    const reqRows = db.prepare('SELECT * FROM table_requests WHERE requested = 1').all();
    reqRows.forEach(r => {
        if (!tableRequests[r.restaurant]) tableRequests[r.restaurant] = {};
        tableRequests[r.restaurant][r.table_number] = true;
    });

    const orderRows = db.prepare('SELECT * FROM orders').all();
    const orders = orderRows.map(o => ({
        orderId: o.order_id,
        restaurant: o.restaurant,
        tableNumber: o.table_number,
        items: JSON.parse(o.items),
        total: o.total,
        kitchenStatus: o.kitchen_status,
        billStatus: o.bill_status,
        date: o.date,
        timestamp: o.timestamp
    }));

    return { tables, tableRequests, orders, activeSessions };
}

// Helper to check if a session is valid based on its configured lifetime
function isSessionValid(session) {
    if (!session) return false;
    const lifetimeMs = (session.lifetime_minutes || 15) * 60 * 1000;
    return (Date.now() - session.start_time <= lifetimeMs);
}

// API endpoint to validate token and return table & restaurant info
app.get('/api/verify-token', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: 'Missing token' });

    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!isSessionValid(session)) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    res.json({ success: true, restaurant: session.restaurant, tableNumber: session.table_number, lifetimeMinutes: session.lifetime_minutes || 15 });
});

// API endpoint to create/retrieve session token from customer.html
app.post('/api/create-session', (req, res) => {
    const { restaurant, tableNumber } = req.body;
    if (!restaurant || !tableNumber) {
        return res.status(400).json({ success: false, message: 'Restaurant and table number required' });
    }

    try {
        const resto = path.basename(restaurant);
        const tKey = String(tableNumber);

        let session = db.prepare('SELECT * FROM sessions WHERE restaurant = ? AND table_number = ?').get(resto, tKey);
        let token;
        const now = Date.now();

        if (isSessionValid(session)) {
            token = session.token;
        } else {
            token = 'tok_' + uuidv4().replace(/-/g, '') + now.toString(36);
            db.prepare(`
                INSERT OR REPLACE INTO sessions (token, restaurant, table_number, start_time, lifetime_minutes)
                VALUES (?, ?, ?, ?, 15)
            `).run(token, resto, tKey, now);
        }

        res.json({ success: true, token });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

io.on('connection', (socket) => {
    socket.emit('state_update', getAppState());

    socket.on('register_session', ({ token }, callback) => {
        const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
        if (!isSessionValid(session)) {
            if (typeof callback === 'function') callback({ success: false, message: 'Invalid token' });
            return;
        }

        const resto = session.restaurant;
        const tKey = session.table_number;
        const sessionKey = `${resto}_${tKey}`;

        if (!tableSockets[sessionKey]) tableSockets[sessionKey] = new Set();
        tableSockets[sessionKey].add(socket.id);
        socket.tableSessionKey = sessionKey;
        socket.tableToken = token;

        socket.join(`table_${resto}_${tKey}`);

        io.emit('state_update', getAppState());
        if (typeof callback === 'function') callback({ success: true, restaurant: resto, tableNumber: tKey });
    });

    socket.on('update_cart', ({ token, cart }) => {
        const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
        if (!isSessionValid(session)) return;
        socket.to(`table_${session.restaurant}_${session.table_number}`).emit('cart_synced', { cart });
    });

    socket.on('disconnect', () => {
        const sessionKey = socket.tableSessionKey;
        const token = socket.tableToken;
        if (sessionKey && tableSockets[sessionKey]) {
            tableSockets[sessionKey].delete(socket.id);

            if (tableSockets[sessionKey].size === 0) {
                delete tableSockets[sessionKey];
                const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
                if (session && !isSessionValid(session)) {
                    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
                }
            }

            io.emit('state_update', getAppState());
        }
    });

    socket.on('toggle_table', ({ restaurant, tableNum }) => {
        const resto = restaurant || 'Default';
        const tKey = String(tableNum);

        const current = db.prepare('SELECT is_open FROM tables_state WHERE restaurant = ? AND table_number = ?').get(resto, tKey);
        if (current) {
            const newOpen = current.is_open ? 0 : 1;
            if (newOpen === 0) {
                db.prepare('UPDATE tables_state SET is_open = 0, can_order = 0 WHERE restaurant = ? AND table_number = ?').run(resto, tKey);
            } else {
                db.prepare('UPDATE tables_state SET is_open = 1 WHERE restaurant = ? AND table_number = ?').run(resto, tKey);
            }
            io.emit('state_update', getAppState());
        }
    });

    socket.on('toggle_order_permission', ({ restaurant, tableNum }) => {
        const resto = restaurant || 'Default';
        const tKey = String(tableNum);

        const current = db.prepare('SELECT can_order FROM tables_state WHERE restaurant = ? AND table_number = ?').get(resto, tKey);
        if (current) {
            const newCanOrder = current.can_order ? 0 : 1;
            db.prepare('UPDATE tables_state SET can_order = ? WHERE restaurant = ? AND table_number = ?').run(newCanOrder, resto, tKey);
            if (newCanOrder) {
                db.prepare('DELETE FROM table_requests WHERE restaurant = ? AND table_number = ?').run(resto, tKey);
            }
            io.emit('state_update', getAppState());
        }
    });

    socket.on('table_request', ({ token }) => {
        const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
        if (!isSessionValid(session)) return;

        db.prepare(`
            INSERT INTO table_requests (restaurant, table_number, requested) VALUES (?, ?, 1)
            ON CONFLICT(restaurant, table_number) DO UPDATE SET requested = 1
        `).run(session.restaurant, session.table_number);

        io.emit('state_update', getAppState());
    });

    socket.on('place_order', ({ items, total, token }, callback) => {
        const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
        if (!isSessionValid(session)) {
            return callback({ success: false, message: 'Session expired or unauthorized.' });
        }

        const resto = session.restaurant;
        const tKey = session.table_number;

        const tableState = db.prepare('SELECT * FROM tables_state WHERE restaurant = ? AND table_number = ?').get(resto, tKey);
        if (!tableState || !tableState.is_open || !tableState.can_order) {
            return callback({ success: false, message: 'Order submission is locked by the manager.' });
        }

        const orderId = uuidv4();
        const date = new Date().toISOString().split('T')[0];
        const timestamp = new Date().toLocaleTimeString();
        const formattedItems = JSON.stringify(items.map(i => ({ ...i, checks: [false, false] })));

        const insertOrder = db.transaction(() => {
            db.prepare(`
                INSERT INTO orders (order_id, restaurant, table_number, items, total, kitchen_status, bill_status, date, timestamp)
                VALUES (?, ?, ?, ?, ?, 'Received', 'Unpaid', ?, ?)
            `).run(orderId, resto, tKey, formattedItems, total, date, timestamp);

            db.prepare('UPDATE tables_state SET can_order = 0 WHERE restaurant = ? AND table_number = ?').run(resto, tKey);
        });

        insertOrder();
        io.to(`table_${resto}_${tKey}`).emit('order_placed_success');
        io.emit('state_update', getAppState());
        callback({ success: true, orderId });
    });

    socket.on('update_kitchen_status', ({ orderId, kitchenStatus }) => {
        db.prepare('UPDATE orders SET kitchen_status = ? WHERE order_id = ?').run(kitchenStatus, orderId);

        const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
        if (order) {
            if (kitchenStatus === 'Sent to Table') {
                io.to(`table_${order.restaurant}_${order.tableNumber}`).emit('order_ready_alert', {
                    orderId: order.order_id,
                    tableNumber: order.table_number
                });
            }

            const sessionKey = `${order.restaurant}_${order.tableNumber}`;
            const subs = tablePushSubscriptions[sessionKey] || [];

            const payload = JSON.stringify({
                title: kitchenStatus === 'Sent to Table' ? 'Order Delivered! 🍽️' : 'Kitchen Update 🍳',
                body: kitchenStatus === 'Sent to Table' ? 'Your food has been delivered to your table!' : `Your order status is now: ${kitchenStatus}`
            });

            subs.forEach(sub => {
                webpush.sendNotification(sub, payload).catch(err => console.error('Push send error:', err));
            });
        }

        io.emit('state_update', getAppState());
    });

    socket.on('toggle_item_check', ({ orderId, itemIndex, checkIndex }) => {
        const orderRow = db.prepare('SELECT items FROM orders WHERE order_id = ?').get(orderId);
        if (orderRow) {
            let items = JSON.parse(orderRow.items);
            if (items[itemIndex]) {
                if (!items[itemIndex].checks) items[itemIndex].checks = [false, false];
                items[itemIndex].checks[checkIndex] = !items[itemIndex].checks[checkIndex];

                const allCook = items.every(i => i.checks && i.checks[0] && !i.checks[1]);
                const allReady = items.every(i => i.checks && i.checks[1]);
                let statusUpdate = null;
                if (allReady) statusUpdate = 'Ready';
                else if (allCook) statusUpdate = 'Cooking';

                if (statusUpdate) {
                    db.prepare('UPDATE orders SET items = ?, kitchen_status = ? WHERE order_id = ?').run(JSON.stringify(items), statusUpdate, orderId);
                } else {
                    db.prepare('UPDATE orders SET items = ? WHERE order_id = ?').run(JSON.stringify(items), orderId);
                }
                io.emit('state_update', getAppState());
            }
        }
    });

    socket.on('update_bill_status', ({ orderId, billStatus }) => {
        const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
        if (order) {
            db.prepare('UPDATE orders SET bill_status = ? WHERE order_id = ?').run(billStatus, orderId);
            if (billStatus === 'Paid') {
                db.prepare(`
                    INSERT OR REPLACE INTO paid_history (order_id, restaurant, table_number, items, total, kitchen_status, bill_status, date, timestamp)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(order.order_id, order.restaurant, order.table_number, order.items, order.total, order.kitchen_status, 'Paid', order.date, order.timestamp);
            }
            io.emit('state_update', getAppState());
        }
    });

    socket.on('clear_bill', ({ orderId }) => {
        db.prepare('DELETE FROM orders WHERE order_id = ?').run(orderId);
        io.emit('state_update', getAppState());
    });
});

app.get('/api/restaurants', (req, res) => {
    try {
        const files = fs.readdirSync(restaurantsDir);
        const restaurants = files.filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'));
        res.json(restaurants);
    } catch (e) {
        res.status(500).json({ error: 'Unable to scan restaurants directory' });
    }
});

app.get('/api/qr-links', (req, res) => {
    try {
        const targetResto = req.query.restaurant;
        const lifetimeMinutes = parseInt(req.query.lifetime) || 15;
        const files = fs.readdirSync(restaurantsDir);
        let restaurants = files.filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'));
        if (targetResto) {
            restaurants = restaurants.filter(r => r === targetResto);
        }

        const allLinks = [];
        restaurants.forEach(resto => {
            const restoTables = db.prepare('SELECT table_number FROM tables_state WHERE restaurant = ?').all(resto);
            restoTables.forEach(t => {
                const tableNumStr = String(t.table_number);

                let session = db.prepare('SELECT * FROM sessions WHERE restaurant = ? AND table_number = ?').get(resto, tableNumStr);
                let token;
                const now = Date.now();

                if (isSessionValid(session)) {
                    token = session.token;
                } else {
                    token = 'tok_' + uuidv4().replace(/-/g, '') + now.toString(36);
                    db.prepare(`
                        INSERT OR REPLACE INTO sessions (token, restaurant, table_number, start_time, lifetime_minutes)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(token, resto, tableNumStr, now, lifetimeMinutes);
                }

                const encodedTbl = Buffer.from(tableNumStr).toString('base64').replace(/=/g, '').split('').reverse().join('');
                const encodedResto = Buffer.from(resto).toString('base64').replace(/=/g, '').split('').reverse().join('');

                allLinks.push({
                    restaurant: resto,
                    tableNumber: t.table_number,
                    encodedUrl: `/customer.html?tbl=${encodedTbl}&rst=${encodedResto}`
                });
            });
        });
        res.json(allLinks);
    } catch (e) {
        console.error('QR Links Error:', e);
        res.status(500).json({ error: 'Failed to generate QR links', details: e.message });
    }
});

app.post('/api/tables/:restaurantName', (req, res) => {
    const restaurantName = req.params.restaurantName;
    const { tableNumber } = req.body;
    const safeName = path.basename(restaurantName);

    if (!tableNumber) return res.status(400).json({ success: false, message: 'Table number required' });

    db.prepare(`
        INSERT INTO tables_state (restaurant, table_number, is_open, can_order, status)
        VALUES (?, ?, 0, 0, 'Valid')
        ON CONFLICT(restaurant, table_number) DO NOTHING
    `).run(safeName, String(tableNumber));

    io.emit('state_update', getAppState());
    res.json({ success: true });
});

app.delete('/api/tables/:restaurantName/:tableNumber', (req, res) => {
    const { restaurantName, tableNumber } = req.params;
    const safeName = path.basename(restaurantName);
    db.prepare('DELETE FROM tables_state WHERE restaurant = ? AND table_number = ?').run(safeName, String(tableNumber));
    io.emit('state_update', getAppState());
    res.json({ success: true });
});

app.get('/api/menu/:restaurantName', (req, res) => {
    const safeName = path.basename(req.params.restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);
    if (fs.existsSync(menuFilePath)) {
        res.json(JSON.parse(fs.readFileSync(menuFilePath, 'utf8')));
    } else {
        res.json([]);
    }
});

app.post('/api/menu/:restaurantName', (req, res) => {
    const safeName = path.basename(req.params.restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);
    let menu = [];
    if (fs.existsSync(menuFilePath)) menu = JSON.parse(fs.readFileSync(menuFilePath, 'utf8'));

    const { category, nameEn, nameAr, price } = req.body;
    let cat = menu.find(c => c.categoryEn === category);
    const newItem = { id: uuidv4(), nameEn, nameAr: nameAr || nameEn, price: parseFloat(price) || 0 };

    if (cat) {
        cat.items.push(newItem);
    } else {
        menu.push({ categoryEn: category, categoryAr: category, items: [newItem] });
    }

    fs.writeFileSync(menuFilePath, JSON.stringify(menu, null, 4), 'utf8');
    io.emit('menu_updated', { restaurant: safeName, menu });
    res.json({ success: true, item: newItem });
});

app.put('/api/menu/:restaurantName/:itemId', (req, res) => {
    const { restaurantName, itemId } = req.params;
    const safeName = path.basename(restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);
    if (!fs.existsSync(menuFilePath)) return res.status(404).json({ success: false });

    let menu = JSON.parse(fs.readFileSync(menuFilePath, 'utf8'));
    const { category, nameEn, nameAr, price } = req.body;
    let found = false;

    menu.forEach(cat => {
        const idx = cat.items.findIndex(i => i.id === itemId);
        if (idx !== -1) {
            cat.items[idx] = { ...cat.items[idx], nameEn, nameAr: nameAr || nameEn, price: parseFloat(price) || 0 };
            found = true;
        }
    });

    if (found) {
        fs.writeFileSync(menuFilePath, JSON.stringify(menu, null, 4), 'utf8');
        io.emit('menu_updated', { restaurant: safeName, menu });
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false });
    }
});

app.delete('/api/menu/:restaurantName/:itemId', (req, res) => {
    const { restaurantName, itemId } = req.params;
    const safeName = path.basename(restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);
    if (!fs.existsSync(menuFilePath)) return res.status(404).json({ success: false });

    let menu = JSON.parse(fs.readFileSync(menuFilePath, 'utf8'));
    menu.forEach(cat => {
        cat.items = cat.items.filter(i => i.id !== itemId);
    });

    fs.writeFileSync(menuFilePath, JSON.stringify(menu, null, 4), 'utf8');
    io.emit('menu_updated', { restaurant: safeName, menu });
    res.json({ success: true });
});

app.get('/api/revenue', (req, res) => {
    const history = db.prepare('SELECT * FROM paid_history').all();
    const report = {};

    history.forEach(ord => {
        const resto = ord.restaurant || 'Default';
        const date = ord.date || new Date().toISOString().split('T')[0];
        const tbl = String(ord.table_number);

        if (!report[resto]) report[resto] = {};
        if (!report[resto][date]) report[resto][date] = {};
        if (!report[resto][date][tbl]) report[resto][date][tbl] = 0;

        report[resto][date][tbl] += (ord.total || 0);
    });

    res.json(report);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Advanced Multi-Restaurant Server running on port ${PORT}`);
});