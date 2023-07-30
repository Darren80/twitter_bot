const app = require('express')();
const cors = require('cors');
const http = require('http').Server(app);
require('dotenv').config()

// import App from './TwitterBot';
const App = require('./TwitterBot.js');

const port = 1000;

// Enable CORS from any origin
app.use(cors());

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
}
);

// app.get('/', (req, res) => {
//     res.send('You ' + req.ip + ' refreshed the bot');
//     console.log(req.ip + ' refreshed the bot');
// });
app.get('/keepalive', (req, res) => {
    res.send('You ', req.headers['x-forwarded-for'] || req.socket.remoteAddress , ' refreshed the bot');
    console.log(req.headers['x-forwarded-for'] || req.socket.remoteAddress  + ' refreshed the bot');
});

// Health check endpoint
app.get('/heartbeat', (req, res) => {
    res.send('I am alive');
});

// Start the twitter bot
app.get('/start', (req, res) => {
    console.log('Starting the bot...');
    App();
    res.send('Starting the bot...');
});

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
});
