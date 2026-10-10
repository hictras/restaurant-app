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

// Persistent storage file paths
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const menuFilePath = path.join(__dirname, 'items.json');
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

let tables = loadJSON(tablesFilePath, {
    1: { isOpen: false, status: 'Valid' },
    2: { isOpen: false, status: 'Valid' },
    3: { isOpen: false, status: 'Valid' },
    4: { isOpen: false, status: 'Valid' },
    5: { isOpen: false, status: 'Valid' },
    6: { isOpen: false, status: 'Valid' }
});
let tableRequests = loadJSON(requestsFilePath, {});
let orders = loadJSON(ordersFilePath, []);
let paidOrderHistory = loadJSON(paidHistoryFilePath, []);

function syncTableStatuses() {
    const activeTablesWithUnpaidBills = new Set(
        orders.filter(o => o.billStatus !== 'Paid').map(o => String(o.tableNumber))
    );
    let changed = false;
    for (let tNum in tables) {
        if (activeTablesWithUnpaidBills.has(tNum) && tables[tNum].status !== 'Occupied') {
            tables[tNum].status = 'Occupied';
            changed = true;
        } else if (!activeTablesWithUnpaidBills.has(tNum) && tables[tNum].status === 'Occupied') {
            tables[tNum].status = 'Valid';
            changed = true;
        }
    }
    if (changed) saveJSON(tablesFilePath, tables);
}

io.on('connection', (socket) => {
    socket.emit('state_update', { tables, tableRequests, orders });

    socket.on('toggle_table', ({ tableNum }) => {
        const tKey = String(tableNum);
        if (tables[tKey]) {
            tables[tKey].isOpen = !tables[tKey].isOpen;
            if (tables[tKey].isOpen) delete tableRequests[tKey];
            saveJSON(tablesFilePath, tables);
            saveJSON(requestsFilePath, tableRequests);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('table_request', ({ tableNumber }) => {
        if (tableNumber) {
            tableRequests[String(tableNumber)] = true;
            saveJSON(requestsFilePath, tableRequests);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('place_order', ({ tableNumber, items, total }, callback) => {
        const tKey = String(tableNumber);
        if (!tables[tKey] || !tables[tKey].isOpen) {
            return callback({ success: false, message: 'Table is closed by manager.' });
        }
        const newOrder = {
            orderId: uuidv4(),
            tableNumber: tKey,
            items: items.map(i => ({ ...i, checks: [false, false] })),
            total,
            kitchenStatus: 'Received',
            billStatus: 'Unpaid',
            date: new Date().toISOString().split('T')[0],
            timestamp: new Date().toLocaleTimeString()
        };
        orders.push(newOrder);
        tables[tKey].isOpen = false;
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

app.get('/api/menu', (req, res) => res.json(loadJSON(menuFilePath, [])));
app.post('/api/menu', (req, res) => {
    const { nameEn, nameAr, price, category } = req.body;
    let menuCategories = loadJSON(menuFilePath, []);
    const newItem = {
        id: 'item_' + Date.now(),
        nameEn: nameEn || 'New Item',
        nameAr: nameAr || nameEn || 'صنف جديد',
        price: parseFloat(price) || 0,
        descEn: '', descAr: ''
    };
    let cat = menuCategories.find(c => c.categoryEn === category);
    if (!cat) {
        cat = { categoryEn: category || "Specials", categoryAr: "أطباق مميزة", items: [] };
        menuCategories.push(cat);
    }
    cat.items.push(newItem);
    saveJSON(menuFilePath, menuCategories);
    io.emit('menu_updated', menuCategories);
    res.json({ success: true, item: newItem });
});
app.delete('/api/menu/:id', (req, res) => {
    const id = req.params.id;
    let menuCategories = loadJSON(menuFilePath, []);
    menuCategories.forEach(cat => { cat.items = cat.items.filter(i => i.id !== id); });
    saveJSON(menuFilePath, menuCategories);
    io.emit('menu_updated', menuCategories);
    res.json({ success: true });
});

app.get('/api/revenue', (req, res) => {
    const allPaid = [...paidOrderHistory, ...orders.filter(o => o.billStatus === 'Paid')];
    const revenueReport = {};
    allPaid.forEach(o => {
        const date = o.date || new Date().toISOString().split('T')[0];
        const tbl = o.tableNumber;
        if (!revenueReport[date]) revenueReport[date] = {};
        if (!revenueReport[date][tbl]) revenueReport[date][tbl] = 0;
        revenueReport[date][tbl] += o.total;
    });
    res.json(revenueReport);
});

server.listen(3000, () => {
    console.log('🚀 Advanced Restaurant Server running at http://localhost:3000');
});