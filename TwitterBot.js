const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const http = require('http');
const https = require('https');
const axiosRetry = require('axios-retry');
const ProgressBar = require('progress');
const cron = require('node-cron');

const TwitterApi = require('twitter-api-v2').default;

// OAuth 1.0a (User context)
const userClient = new TwitterApi({
  appKey: process.env.APP_KEY,
  appSecret: process.env.APP_SECRET,
  // Following access tokens are not required if you are
  // at part 1 of user-auth process (ask for a request token)
  // or if you want a app-only client (see below)
  accessToken: process.env.ACCESS_TOKEN,
  accessSecret: process.env.ACCESS_SECRET,
});

// Instantiate with desired auth type (here's Bearer v2 auth)
// const twitterClient = new TwitterApi('');

// Axios
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// Name of the file to store the posted clip IDs
const postedClipsFile = path.join(__dirname, 'postedClips.txt');

axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 360000;

const client_secret = process.env.REACT_APP_TWITCH_CLIENT_SECRET;
const client_id = process.env.REACT_APP_TWITCH_CLIENT_ID;
let accessToken = '';
let userID = '';
const numberOfClipsToUpload = 3;

async function getTwitchClips(streamerName) {
  // Authenticate with Twitch
  const url = `https://id.twitch.tv/oauth2/token?client_id=${client_id}&client_secret=${client_secret}&grant_type=client_credentials`;
  // console.log(process.env);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const data = await response.json();
  accessToken = data.access_token;
  await getUserID(streamerName);
}

async function getUserID(streamerName) {
  const response = await fetch(`https://api.twitch.tv/helix/users?login=${streamerName}`, {
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

  const topClips = clips.slice(0, numberOfClipsToUpload);
  await downloadClips(topClips);
}

async function downloadClips(clips) {
  for (let i = 0; i < clips.length && i < clips.length; i++) {
    await downloadClip(clips[i]);
  }
}

let topClipsPath = [];
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

  console.log(clip);

  // If the directory doesn't exist, create it
  if (!fs.existsSync(path.join(__dirname, `/vids/${clip.broadcaster_name}`))) { fs.mkdirSync(path.join(__dirname, `/vids/${clip.broadcaster_name}`)); }

  const localFilePath = path.join(__dirname, `/vids/${clip.broadcaster_name}/${clip.id}.mp4`);
  const fileStream = fs.createWriteStream(localFilePath);

  response.data.on('data', (chunk) => progressBar.tick(chunk.length));
  response.data.pipe(fileStream);

  response.data.on('error', console.error);
  fileStream.on('error', console.error);

  return new Promise((resolve, reject) => {
    fileStream.on('finish', () => {
      console.log(`\nDownloaded: ${clip.id}.mp4`);
      topClipsPath.push(localFilePath);
      // Post to Twitter
      postToTwitter(clip.title);
      resolve();
    });
    fileStream.on('error', reject);
  });
}

// Twitter
async function postToTwitter(title) {

  // Read the posted clip IDs from the file into a Set
  let postedClips;
  try {
    const fileContent = fs.readFileSync(postedClipsFile, 'utf-8');
    postedClips = new Set(fileContent.split('\n'));
  } catch (err) {
    // If the file doesn't exist, start with an empty Set
    if (err.code === 'ENOENT') {
      postedClips = new Set();
    } else {
      throw err;
    }
  }

  // if postedClipsFile already has the posted clip then remove it from topClipsPath.
  if (postedClips.has(topClipsPath[0])) {
    console.log('Already posted:', topClipsPath[0]);
    topClipsPath.shift();
    return;
  }

  // Check if there are any clips to post.
  if (topClipsPath.length === 0) {
    console.log('No more clips to post.');
    return;
  }

  // Treat topClips like a queue
  const clipPath = topClipsPath.shift();
  console.log('Posting to Twitter:', clipPath);

  const { size } = fs.statSync(clipPath);
  console.log('Uploading video of size', size, 'bytes');

  // Upload the video
  const media_id = await userClient.v1.uploadMedia(clipPath);
  // Tweet the video
  const newTweet = await userClient.v2.tweet(title, {
    media: { media_ids: [media_id] }
  });
  console.log('Tweet ID:', newTweet);

  // Add the posted clip to the Set
  postedClips.add(newTweet);
  // Then write the Set back to the file
  fs.appendFile(postedClipsFile, clip.id + '\n');
  console.log('Wrote to file:', postedClipsFile);

  // Fulfill the promise
  return newTweet;
}
// Configure retries
axiosRetry(axios, {
  retries: 3, // number of retry when a network error happens
  retryDelay: axiosRetry.exponentialDelay, // delay between retry (exponential growth)
  retryCondition: (error) => {
    // only retry for network errors and if response status is 5xx
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response.status >= 500;
  },
});

// Schedule the jobs
cron.schedule('0 19 * * *', getTwitchClips, { timezone: "GMT" });
cron.schedule('0 19-21 * * *', postToTwitter, { timezone: "GMT" });

getTwitchClips('kaicenat');
