const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const http = require('http');
const https = require('https');
const axiosRetry = require('axios-retry');
const ProgressBar = require('progress');
const Twit = require('twit');

// Axios
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 360000;

const client_secret = process.env.REACT_APP_TWITCH_CLIENT_SECRET;
const client_id = process.env.REACT_APP_TWITCH_CLIENT_ID;
const username = 'xqc';
let accessToken = '';
let userID = '';
const numClips = 3;

async function getTwitchClips() {
  const url = `https://id.twitch.tv/oauth2/token?client_id=${client_id}&client_secret=${client_secret}&grant_type=client_credentials`;
  // console.log(process.env);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const data = await response.json();
  accessToken = data.access_token;
  await getUserID();
}

async function getUserID() {
  const response = await fetch(`https://api.twitch.tv/helix/users?login=${username}`, {
    headers: {
      'Client-ID': client_id,
      'Authorization': `Bearer ${accessToken}`,
    }
  });
  const data = await response.json();
  userID = data.data[0].id;
  await getClips();
}

async function getClips() {
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);

  const url = `https://api.twitch.tv/helix/clips?broadcaster_id=${userID}&started_at=${oneDayAgo.toISOString()}&ended_at=${new Date().toISOString()}`;
  const response = await fetch(url, {
    headers: {
      'Client-ID': client_id,
      'Authorization': `Bearer ${accessToken}`,
    }
  });
  const data = await response.json();

  getMostViewedClips(data.data);
}

async function getMostViewedClips(clips) {
  clips.sort((a, b) => b.views - a.views);

  const topClips = clips.slice(0, numClips);
  await downloadClips(topClips);
}

async function downloadClips(clips) {
  for (let i = 0; i < clips.length && i < clips.length; i++) {
    await downloadClip(clips[i]);
  }
}

async function downloadClip(clip) {
  const vodUrl = clip.thumbnail_url.split('-preview', 1)[0] + '.mp4'; console.log(vodUrl);

  const response = await axios({
    method: 'get',
    url: vodUrl,
    responseType: 'stream'
  });

  const totalBytes = parseInt(response.headers['content-length'], 10);
  const progressBar = new ProgressBar('-> downloading [:bar] :percent :etas', {
    width: 40,
    complete: '=',
    incomplete: ' ',
    renderThrottle: 1,
    total: totalBytes
  });

  const localFilePath = path.join(__dirname, `${clip.id}.mp4`);
  const fileStream = fs.createWriteStream(localFilePath);
  response.data.on('data', (chunk) => progressBar.tick(chunk.length));
  response.data.pipe(fileStream);

  response.data.on('error', console.error);
  fileStream.on('error', console.error);

  return new Promise((resolve, reject) => {
    fileStream.on('finish', () => {
      console.log(`\nDownloaded: ${clip.id}.mp4`);
      await postToTwitter(localFilePath, clip.title);
      resolve();
    });
    fileStream.on('error', reject);
  });
}

// Twitter
async function postToTwitter(localFilePath, title) {
  const T = new Twit({
    consumer_key: '...',
    consumer_secret: '...',
    access_token: '...',
    access_token_secret: '...'
  });
  

// Configure retries
axiosRetry(axios, {
  retries: 3, // number of retry when a network error happens
  retryDelay: axiosRetry.exponentialDelay, // delay between retry (exponential growth)
  retryCondition: (error) => {
    // only retry for network errors and if response status is 5xx
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response.status >= 500;
  },
});

getTwitchClips();
setInterval(getTwitchClips, 3600000);
