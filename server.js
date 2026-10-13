const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const restaurantsDir = path.join(__dirname, 'restaurants');
if (!fs.existsSync(restaurantsDir)) fs.mkdirSync(restaurantsDir);

const tablesFilePath = path.join(dataDir, 'tables.json');
const requestsFilePath = path.join(dataDir, 'requests.json');
const ordersFilePath = path.join(dataDir, 'orders.json');
const paidHistoryFilePath = path.join(dataDir, 'paidHistory.json');

function loadJSON(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            if (!data.trim()) return defaultValue;
            return JSON.parse(data);
        }
    } catch (e) { console.error(`Error reading ${filePath}:`, e.message); }
    return defaultValue;
}

function saveJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
    } catch (e) { console.error(`Error writing ${filePath}:`, e); }
}

let tables = loadJSON(tablesFilePath, {});
let tableRequests = loadJSON(requestsFilePath, {});
let orders = loadJSON(ordersFilePath, []);
let paidOrderHistory = loadJSON(paidHistoryFilePath, []);

function ensureRestaurantTables(restaurantName) {
    if (!tables[restaurantName]) {
        tables[restaurantName] = {}; // Strictly empty by default until added from JSON/Admin
        saveJSON(tablesFilePath, tables);
    }
    if (!tableRequests[restaurantName]) {
        tableRequests[restaurantName] = {};
    }
}

function syncTableStatuses() {
    let changed = false;
    for (let resto in tables) {
        const activeTablesWithUnpaidBills = new Set(
            orders.filter(o => (o.restaurant || 'Default') === resto && o.billStatus !== 'Paid').map(o => String(o.tableNumber))
        );
        for (let tNum in tables[resto]) {
            if (activeTablesWithUnpaidBills.has(tNum) && tables[resto][tNum].status !== 'Occupied') {
                tables[resto][tNum].status = 'Occupied';
                changed = true;
            } else if (!activeTablesWithUnpaidBills.has(tNum) && tables[resto][tNum].status === 'Occupied') {
                tables[resto][tNum].status = 'Valid';
                changed = true;
            }
        }
    }
    if (changed) saveJSON(tablesFilePath, tables);
}

// Secure Obfuscation Helper for QR Codes
function encodeTableParam(text) {
    return Buffer.from(String(text)).toString('base64').replace(/=/g, '').split('').reverse().join('');
}

io.on('connection', (socket) => {
    socket.emit('state_update', { tables, tableRequests, orders });

    socket.on('toggle_table', ({ restaurant, tableNum }) => {
        const resto = restaurant || 'Default';
        ensureRestaurantTables(resto);
        const tKey = String(tableNum);
        if (tables[resto] && tables[resto][tKey]) {
            tables[resto][tKey].isOpen = !tables[resto][tKey].isOpen;
            if (!tables[resto][tKey].isOpen) {
                tables[resto][tKey].canOrder = false;
            }
            saveJSON(tablesFilePath, tables);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('toggle_order_permission', ({ restaurant, tableNum }) => {
        const resto = restaurant || 'Default';
        ensureRestaurantTables(resto);
        const tKey = String(tableNum);
        if (tables[resto] && tables[resto][tKey]) {
            tables[resto][tKey].canOrder = !tables[resto][tKey].canOrder;
            if (tables[resto][tKey].canOrder && tableRequests[resto]) {
                delete tableRequests[resto][tKey];
            }
            saveJSON(tablesFilePath, tables);
            saveJSON(requestsFilePath, tableRequests);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('table_request', ({ restaurant, tableNumber }) => {
        const resto = restaurant || 'Default';
        ensureRestaurantTables(resto);
        if (tableNumber) {
            if (!tableRequests[resto]) tableRequests[resto] = {};
            tableRequests[resto][String(tableNumber)] = true;
            saveJSON(requestsFilePath, tableRequests);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('place_order', ({ tableNumber, restaurant, items, total }, callback) => {
        const resto = restaurant || 'Default';
        ensureRestaurantTables(resto);
        const tKey = String(tableNumber);

        if (!tables[resto][tKey] || !tables[resto][tKey].isOpen || !tables[resto][tKey].canOrder) {
            return callback({ success: false, message: 'Order submission is locked by the manager.' });
        }

        const newOrder = {
            orderId: uuidv4(),
            tableNumber: tKey,
            restaurant: resto,
            items: items.map(i => ({ ...i, checks: [false, false] })),
            total,
            kitchenStatus: 'Received',
            billStatus: 'Unpaid',
            date: new Date().toISOString().split('T')[0],
            timestamp: new Date().toLocaleTimeString()
        };

        orders.push(newOrder);
        tables[resto][tKey].canOrder = false;
        saveJSON(ordersFilePath, orders);
        saveJSON(tablesFilePath, tables);
        syncTableStatuses();
        io.emit('state_update', { tables, tableRequests, orders });
        callback({ success: true, orderId: newOrder.orderId });
    });

    socket.on('update_kitchen_status', ({ orderId, kitchenStatus }) => {
        const order = orders.find(o => o.orderId === orderId);
        if (order && kitchenStatus) {
            order.kitchenStatus = kitchenStatus;
            saveJSON(ordersFilePath, orders);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('toggle_item_check', ({ orderId, itemIndex, checkIndex }) => {
        const order = orders.find(o => o.orderId === orderId);
        if (order && order.items[itemIndex]) {
            if (!order.items[itemIndex].checks) order.items[itemIndex].checks = [false, false];
            order.items[itemIndex].checks[checkIndex] = !order.items[itemIndex].checks[checkIndex];

            const items = order.items;
            const allCook = items.length > 0 && items.every(i => i.checks && i.checks[0] && !i.checks[1]);
            const allReady = items.length > 0 && items.every(i => i.checks && i.checks[1]);

            if (allReady) {
                order.kitchenStatus = 'Ready';
            } else if (allCook) {
                order.kitchenStatus = 'Cooking';
            }

            saveJSON(ordersFilePath, orders);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('update_bill_status', ({ orderId, billStatus }) => {
        const order = orders.find(o => o.orderId === orderId);
        if (order && billStatus) {
            order.billStatus = billStatus;
            if (billStatus === 'Paid') {
                paidOrderHistory.push({ ...order });
                saveJSON(paidHistoryFilePath, paidOrderHistory);
            }
            saveJSON(ordersFilePath, orders);
            syncTableStatuses();
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('clear_bill', ({ orderId }) => {
        orders = orders.filter(o => o.orderId !== orderId);
        saveJSON(ordersFilePath, orders);
        syncTableStatuses();
        io.emit('state_update', { tables, tableRequests, orders });
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

// QR Links Generator Endpoint for Admin Printing (Filtered by Active Restaurant)
app.get('/api/qr-links', (req, res) => {
    try {
        const targetResto = req.query.restaurant;
        const files = fs.readdirSync(restaurantsDir);
        let restaurants = files.filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'));

        if (targetResto) {
            restaurants = restaurants.filter(r => r === targetResto);
        }

        const allLinks = [];

        restaurants.forEach(resto => {
            ensureRestaurantTables(resto);
            const restoTables = tables[resto] || {};
            const encodedResto = encodeTableParam(resto);

            for (let tNum in restoTables) {
                const encodedTbl = encodeTableParam(tNum);
                allLinks.push({
                    restaurant: resto,
                    tableNumber: tNum,
                    encodedUrl: `/customer.html?tbl=${encodedTbl}&rst=${encodedResto}`
                });
            }
        });
        res.json(allLinks);
    } catch (e) {
        res.status(500).json({ error: 'Failed to generate QR links' });
    }
});

// Add Table Endpoint
app.post('/api/tables/:restaurantName', (req, res) => {
    const restaurantName = req.params.restaurantName;
    const { tableNumber } = req.body;
    const safeName = path.basename(restaurantName);

    if (!tableNumber) {
        return res.status(400).json({ success: false, message: 'Table number is required' });
    }

    ensureRestaurantTables(safeName);
    if (!tables[safeName]) {
        tables[safeName] = {};
    }

    tables[safeName][String(tableNumber)] = { isOpen: false, canOrder: false, status: 'Valid' };
    saveJSON(tablesFilePath, tables);
    io.emit('state_update', { tables, tableRequests, orders });

    res.json({ success: true, message: `Table #${tableNumber} added successfully` });
});

app.get('/api/menu/:restaurantName', (req, res) => {
    const restaurantName = req.params.restaurantName;
    const safeName = path.basename(restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);
    res.json(loadJSON(menuFilePath, []));
});

// Menu Management Endpoints (Add, Edit, Delete)
app.post('/api/menu/:restaurantName', (req, res) => {
    const restaurantName = req.params.restaurantName;
    const safeName = path.basename(restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);
    let menu = loadJSON(menuFilePath, []);

    const { category, nameEn, nameAr, price } = req.body;
    let cat = menu.find(c => c.categoryEn === category);

    const newItem = { id: uuidv4(), nameEn, nameAr: nameAr || nameEn, price: parseFloat(price) || 0 };

    if (cat) {
        cat.items.push(newItem);
    } else {
        menu.push({ categoryEn: category, categoryAr: category, items: [newItem] });
    }

    saveJSON(menuFilePath, menu);
    io.emit('menu_updated', { restaurant: safeName, menu });
    res.json({ success: true, item: newItem });
});

app.put('/api/menu/:restaurantName/:itemId', (req, res) => {
    const { restaurantName, itemId } = req.params;
    const safeName = path.basename(restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);
    let menu = loadJSON(menuFilePath, []);

    const { category, nameEn, nameAr, price } = req.body;
    let found = false;

    menu.forEach(cat => {
        const itemIdx = cat.items.findIndex(i => i.id === itemId);
        if (itemIdx !== -1) {
            cat.items[itemIdx] = { ...cat.items[itemIdx], nameEn, nameAr: nameAr || nameEn, price: parseFloat(price) || 0 };
            found = true;
        }
    });

    if (found) {
        saveJSON(menuFilePath, menu);
        io.emit('menu_updated', { restaurant: safeName, menu });
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, message: 'Item not found' });
    }
});

app.delete('/api/menu/:restaurantName/:itemId', (req, res) => {
    const { restaurantName, itemId } = req.params;
    const safeName = path.basename(restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);
    let menu = loadJSON(menuFilePath, []);

    menu.forEach(cat => {
        cat.items = cat.items.filter(i => i.id !== itemId);
    });

    saveJSON(menuFilePath, menu);
    io.emit('menu_updated', { restaurant: safeName, menu });
    res.json({ success: true });
});

// Revenue Endpoint
app.get('/api/revenue', (req, res) => {
    const history = loadJSON(paidHistoryFilePath, []);
    const report = {};

    history.forEach(ord => {
        const resto = ord.restaurant || 'Default';
        const date = ord.date || new Date().toISOString().split('T')[0];
        const tbl = String(ord.tableNumber);

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