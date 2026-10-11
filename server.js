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

function getDefaultTables() {
    return {
        1: { isOpen: false, status: 'Valid' },
        2: { isOpen: false, status: 'Valid' },
        3: { isOpen: false, status: 'Valid' },
        4: { isOpen: false, status: 'Valid' },
        5: { isOpen: false, status: 'Valid' },
        6: { isOpen: false, status: 'Valid' }
    };
}

let tables = loadJSON(tablesFilePath, {}); // Structure: { restaurantName: { 1: { isOpen, status }, ... } }
let tableRequests = loadJSON(requestsFilePath, {}); // Structure: { restaurantName: { 1: true, ... } }
let orders = loadJSON(ordersFilePath, []);
let paidOrderHistory = loadJSON(paidHistoryFilePath, []);

function ensureRestaurantTables(restaurantName) {
    if (!tables[restaurantName]) {
        tables[restaurantName] = getDefaultTables();
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

io.on('connection', (socket) => {
    socket.emit('state_update', { tables, tableRequests, orders });

    socket.on('toggle_table', ({ restaurant, tableNum }) => {
        const resto = restaurant || 'Default';
        ensureRestaurantTables(resto);
        const tKey = String(tableNum);
        if (tables[resto] && tables[resto][tKey]) {
            tables[resto][tKey].isOpen = !tables[resto][tKey].isOpen;
            if (tables[resto][tKey].isOpen && tableRequests[resto]) {
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
        
        if (!tables[resto][tKey] || !tables[resto][tKey].isOpen) {
            return callback({ success: false, message: 'Table is closed by manager for this restaurant.' });
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
        tables[resto][tKey].isOpen = false;
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

app.get('/api/restaurants', (req, res) => {
    try {
        const files = fs.readdirSync(restaurantsDir);
        const restaurants = files
            .filter(file => file.endsWith('.json'))
            .map(file => path.basename(file, '.json'));
        res.json(restaurants);
    } catch (e) {
        res.status(500).json({ error: 'Unable to scan restaurants directory' });
    }
});

app.get('/api/menu/:restaurantName', (req, res) => {
    const restaurantName = req.params.restaurantName;
    const safeName = path.basename(restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);
    res.json(loadJSON(menuFilePath, []));
});

app.post('/api/menu/:restaurantName', (req, res) => {
    const restaurantName = req.params.restaurantName;
    const safeName = path.basename(restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);

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
    io.emit('menu_updated', { restaurant: safeName, menu: menuCategories });
    res.json({ success: true, item: newItem });
});

app.put('/api/menu/:restaurantName/:id', (req, res) => {
    const restaurantName = req.params.restaurantName;
    const id = req.params.id;
    const safeName = path.basename(restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);

    const { nameEn, nameAr, price, category } = req.body;
    let menuCategories = loadJSON(menuFilePath, []);
    let updatedItem = null;

    menuCategories.forEach(cat => {
        cat.items.forEach(item => {
            if (item.id === id) {
                if (nameEn !== undefined) item.nameEn = nameEn;
                if (nameAr !== undefined) item.nameAr = nameAr || nameEn;
                if (price !== undefined) item.price = parseFloat(price) || 0;
                updatedItem = item;
            }
        });
    });

    saveJSON(menuFilePath, menuCategories);
    io.emit('menu_updated', { restaurant: safeName, menu: menuCategories });
    res.json({ success: true, item: updatedItem });
});

app.delete('/api/menu/:restaurantName/:id', (req, res) => {
    const restaurantName = req.params.restaurantName;
    const id = req.params.id;
    const safeName = path.basename(restaurantName);
    const menuFilePath = path.join(restaurantsDir, `${safeName}.json`);

    let menuCategories = loadJSON(menuFilePath, []);
    menuCategories.forEach(cat => { cat.items = cat.items.filter(i => i.id !== id); });
    saveJSON(menuFilePath, menuCategories);
    io.emit('menu_updated', { restaurant: safeName, menu: menuCategories });
    res.json({ success: true });
});

app.get('/api/revenue', (req, res) => {
    const allPaid = [...paidOrderHistory, ...orders.filter(o => o.billStatus === 'Paid')];
    const revenueReport = {};
    
    allPaid.forEach(o => {
        const resto = o.restaurant || 'Default';
        const date = o.date || new Date().toISOString().split('T')[0];
        const tbl = o.tableNumber;

        if (!revenueReport[resto]) revenueReport[resto] = {};
        if (!revenueReport[resto][date]) revenueReport[resto][date] = {};
        if (!revenueReport[resto][date][tbl]) revenueReport[resto][date][tbl] = 0;
        
        revenueReport[resto][date][tbl] += o.total;
    });

    res.json(revenueReport);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Advanced Multi-Restaurant Server running on port ${PORT}`);
});