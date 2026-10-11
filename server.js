const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const dataDir = path.join(__dirname, 'data');
const restaurantsDir = path.join(__dirname, 'restaurants');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(restaurantsDir)) fs.mkdirSync(restaurantsDir);

const tablesFilePath = path.join(dataDir, 'tables.json');
const ordersFilePath = path.join(dataDir, 'orders.json');
const tableRequestsFilePath = path.join(dataDir, 'tableRequests.json');

function loadJSON(filePath, defaultVal) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) { console.error(`Error loading ${filePath}:`, e); }
    return defaultVal;
}

function saveJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) { console.error(`Error saving ${filePath}:`, e); }
}

let tables = loadJSON(tablesFilePath, {}); // { restaurantName: { "1": { isOpen: false, canOrder: false, status: 'Valid' } } }
let orders = loadJSON(ordersFilePath, []);
let tableRequests = loadJSON(tableRequestsFilePath, {});

function getRestaurantsList() {
    try {
        if (fs.existsSync(restaurantsDir)) {
            return fs.readdirSync(restaurantsDir).filter(f => fs.statSync(path.join(restaurantsDir, f)).isDirectory());
        }
    } catch (e) { console.error('Error reading restaurants directory', e); }
    return ['Default'];
}

function ensureRestaurantTables(restaurant) {
    if (!tables[restaurant]) {
        tables[restaurant] = {};
        for (let i = 1; i <= 10; i++) {
            tables[restaurant][String(i)] = { isOpen: false, canOrder: false, status: 'Valid' };
        }
        saveJSON(tablesFilePath, tables);
    }
}

getRestaurantsList().forEach(resto => ensureRestaurantTables(resto));

function syncTableStatuses() {
    orders.forEach(ord => {
        const resto = ord.restaurant || 'Default';
        ensureRestaurantTables(resto);
        const tKey = String(ord.tableNumber);
        if (tables[resto] && tables[resto][tKey]) {
            if (ord.billStatus === 'Unpaid') {
                tables[resto][tKey].status = 'Occupied';
            }
        }
    });
}
syncTableStatuses();

app.get('/api/restaurants', (req, res) => {
    res.json(getRestaurantsList());
});

app.get('/api/menu/:restaurant', (req, res) => {
    const restaurant = req.params.restaurant;
    const menuPath = path.join(restaurantsDir, restaurant, 'menu.json');
    if (fs.existsSync(menuPath)) {
        res.json(loadJSON(menuPath, []));
    } else {
        res.status(404).json({ error: 'Menu not found' });
    }
});

io.on('connection', (socket) => {
    socket.emit('state_update', { tables, tableRequests, orders });

    socket.on('table_request', ({ restaurant, tableNumber }) => {
        const resto = restaurant || 'Default';
        if (!tableRequests[resto]) tableRequests[resto] = {};
        tableRequests[resto][String(tableNumber)] = true;
        saveJSON(tableRequestsFilePath, tableRequests);
        io.emit('state_update', { tables, tableRequests, orders });
    });

    socket.on('toggle_table', ({ restaurant, tableNum }) => {
        const resto = restaurant || 'Default';
        ensureRestaurantTables(resto);
        const tKey = String(tableNum);
        if (tables[resto] && tables[resto][tKey]) {
            tables[resto][tKey].isOpen = !tables[resto][tKey].isOpen;
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
            saveJSON(tablesFilePath, tables);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('place_order', ({ tableNumber, restaurant, items, total }, callback) => {
        const resto = restaurant || 'Default';
        ensureRestaurantTables(resto);
        const tKey = String(tableNumber);

        if (!tables[resto][tKey] || !tables[resto][tKey].canOrder) {
            return callback({ success: false, message: 'Ordering is currently locked by the admin for this table.' });
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
        tables[resto][tKey].canOrder = false; // Lock ordering button again for next round
        saveJSON(ordersFilePath, orders);
        saveJSON(tablesFilePath, tables);
        syncTableStatuses();
        io.emit('state_update', { tables, tableRequests, orders });
        callback({ success: true, orderId: newOrder.orderId });
    });

    socket.on('update_kitchen_status', ({ orderId, kitchenStatus }) => {
        const ord = orders.find(o => o.orderId === orderId);
        if (ord) {
            ord.kitchenStatus = kitchenStatus;
            saveJSON(ordersFilePath, orders);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('toggle_item_check', ({ orderId, itemIndex, checkIndex }) => {
        const ord = orders.find(o => o.orderId === orderId);
        if (ord && ord.items && ord.items[itemIndex]) {
            if (!ord.items[itemIndex].checks) ord.items[itemIndex].checks = [false, false];
            if (checkIndex === 0) {
                ord.items[itemIndex].checks[0] = !ord.items[itemIndex].checks[0];
                if (ord.items[itemIndex].checks[0]) ord.items[itemIndex].checks[1] = false;
            } else if (checkIndex === 1) {
                ord.items[itemIndex].checks[1] = !ord.items[itemIndex].checks[1];
                if (ord.items[itemIndex].checks[1]) ord.items[itemIndex].checks[0] = false;
            }
            saveJSON(ordersFilePath, orders);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('update_bill_status', ({ orderId, billStatus }) => {
        const ord = orders.find(o => o.orderId === orderId);
        if (ord) {
            ord.billStatus = billStatus;
            if (billStatus === 'Paid') {
                const resto = ord.restaurant || 'Default';
                const tKey = String(ord.tableNumber);
                if (tables[resto] && tables[resto][tKey]) {
                    tables[resto][tKey].isOpen = false;
                    tables[resto][tKey].canOrder = false;
                    tables[resto][tKey].status = 'Valid';
                }
            }
            saveJSON(ordersFilePath, orders);
            saveJSON(tablesFilePath, tables);
            io.emit('state_update', { tables, tableRequests, orders });
        }
    });

    socket.on('clear_table_orders', ({ restaurant, tableNumber }) => {
        const resto = restaurant || 'Default';
        const tKey = String(tableNumber);
        orders = orders.filter(o => !((o.restaurant || 'Default') === resto && String(o.tableNumber) === tKey));
        if (tableRequests[resto]) delete tableRequests[resto][tKey];
        if (tables[resto] && tables[resto][tKey]) {
            tables[resto][tKey].isOpen = false;
            tables[resto][tKey].canOrder = false;
            tables[resto][tKey].status = 'Valid';
        }
        saveJSON(ordersFilePath, orders);
        saveJSON(tablesFilePath, tables);
        saveJSON(tableRequestsFilePath, tableRequests);
        io.emit('state_update', { tables, tableRequests, orders });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));