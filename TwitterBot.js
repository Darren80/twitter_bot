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

// Axios
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.timeout = 360000;

// Configure retries
axiosRetry(axios, {
  retries: 3, // number of retry when a network error happens
  retryDelay: axiosRetry.exponentialDelay, // delay between retry (exponential growth)
  retryCondition: (error) => {
    // only retry for network errors and if response status is 5xx
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response.status >= 500;
  },
});

class TwitchClipDownloader {
  constructor(twitterClient, streamerName, downloadTime, postTime) {
    this.client_secret = process.env.REACT_APP_TWITCH_CLIENT_SECRET;
    this.client_id = process.env.REACT_APP_TWITCH_CLIENT_ID;
    this.accessToken = '';
    this.userID = '';
    this.numberOfClipsToUpload = 3;
    this.userClient = [];
    this.postedClipsFile = path.join(__dirname, '/postedClips.txt');
    this.topClips = [];

    this.setupTwitterClient = this.setupTwitterClient.bind(this);
    this.getTwitchClips = this.getTwitchClips.bind(this);
    this.getUserID = this.getUserID.bind(this);
    this.getClips = this.getClips.bind(this);
    this.getMostViewedClips = this.getMostViewedClips.bind(this);
    this.downloadClips = this.downloadClips.bind(this);
    this.downloadClip = this.downloadClip.bind(this);
    this.postToTwitter = this.postToTwitter.bind(this);

    this.isPosting = false;

    // Start running the bot
    console.log('Starting the bot...');
    this.setupTwitterClient(twitterClient);
    // The postTime should be in the format '00 00 * * *'
    cron.schedule(postTime, () => {
      if (!this.isPosting) {
        this.isPosting = true;
        this.postToTwitter();
        this.isPosting = false;
      }
    }, { timezone: "Etc/GMT" });

    // The downloadTime should be in the format '00 00 * * *'
    cron.schedule(downloadTime,() => {
      this.getTwitchClips(streamerName);
    }, { timezone: "Etc/GMT" });
  }

  async setupTwitterClient(twitterClient) {
    this.userClient = new TwitterApi({
      appKey: process.env[`${twitterClient}_APP_KEY`],
      appSecret: process.env[`${twitterClient}_APP_SECRET`],
      accessToken: process.env[`${twitterClient}_ACCESS_TOKEN`],
      accessSecret: process.env[`${twitterClient}_ACCESS_SECRET`],
    });

    // Return resolved promise
    return Promise.resolve();
  }

  async getTwitchClips(streamerName) {
    // Authenticate with Twitch
    const url = `https://id.twitch.tv/oauth2/token?client_id=${this.client_id}&client_secret=${this.client_secret}&grant_type=client_credentials`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const data = await response.json();
    this.accessToken = data.access_token;
    await this.getUserID(streamerName);
  }

  async getUserID(streamerName) {
    const response = await fetch(`https://api.twitch.tv/helix/users?login=${streamerName}`, {
      headers: {
        'Client-ID': this.client_id,
        'Authorization': `Bearer ${this.accessToken}`,
      }
    });
    const data = await response.json();
    this.userID = data.data[0].id;
    await this.getClips();
  }

  async getClips() {
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);

    const url = `https://api.twitch.tv/helix/clips?broadcaster_id=${this.userID}&started_at=${oneDayAgo.toISOString()}&ended_at=${new Date().toISOString()}`;
    const response = await fetch(url, {
      headers: {
        'Client-ID': this.client_id,
        'Authorization': `Bearer ${this.accessToken}`,
      }
    });
    const data = await response.json();

    this.getMostViewedClips(data.data);
  }

  async getMostViewedClips(clips) {
    clips.sort((a, b) => b.views - a.views);
    const topClips = clips.slice(0, this.numberOfClipsToUpload);
    await this.downloadClips(topClips);
  }

  async downloadClips(clips) {
    for (let i = 0; i < clips.length; i++) {
      await this.downloadClip(clips[i]);
    }
  }

  async downloadClip(clip) {
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

    // console.log(clip);

    // If the directory doesn't exist, create it
    if (!fs.existsSync(path.join(__dirname, `/vids/${clip.broadcaster_name}`))) { fs.mkdirSync(path.join(__dirname, `/vids/${clip.broadcaster_name}`)); }

    // console.log('\nclip: ', clip, '\n');

    const localFilePath = path.join(__dirname, `/vids/${clip.broadcaster_name}/${clip.id}.mp4`);
    // If file exists and its length is equal to the clip length, skip downloading
    if (fs.existsSync(localFilePath)) {
      const fileStats = fs.statSync(localFilePath);
      const totalBytes = parseInt(response.headers['content-length'], 10);
      if (fileStats.size === totalBytes) {
        this.topClips.push({ localFilePath, clip });
        console.log(`File ${clip.title} already exists. Skipping download.\n`);
        return;
      }
    }

    const fileStream = fs.createWriteStream(localFilePath);

    response.data.on('data', (chunk) => progressBar.tick(chunk.length));
    response.data.pipe(fileStream);

    response.data.on('error', console.error);
    fileStream.on('error', console.error);

    return new Promise((resolve, reject) => {
      fileStream.on('finish', async () => {
        console.log(`\nDownloaded: ${clip.id}.mp4`);
        this.topClips.push({ localFilePath, clip });
        // Post to Twitter (use cron job instead)
        // await postToTwitter(clip.title);
        resolve();
      });
      fileStream.on('error', reject);
    });
  }

  // Twitter
  async postToTwitter() {

    console.log(this.topClips.length);

    // Check if there are any clips to post.
    if (this.topClips.length === 0) {
      console.log('Nothing to upload.');
      return;
    }

    // Read the posted clip IDs from the file into a Set
    let postedClips;
    try {
      const fileContent = fs.readFileSync(this.postedClipsFile, 'utf-8');
      postedClips = new Set(fileContent.split('\n'));
    } catch (err) {
      // If the file doesn't exist, start with an empty Set
      if (err.code === 'ENOENT') {
        // and create an empty file
        fs.writeFileSync(postedClipsFile, '');
        postedClips = new Set();
      } else {
        throw err;
      }
    }

    let clip = this.topClips[0].clip;
    const clipID = this.topClips[0].clip.id;

    // if postedClipsFile already has the posted clip then remove it from this.topClipsPath.
    if (postedClips.has(clipID)) {
      console.log('Clip already posted.                            Skipping upload.');
      this.topClips.shift();
      return;
    }

    // Treat this.topClips like a queue
    const clipPath = this.topClips[0].localFilePath;

    const { size } = fs.statSync(clipPath);
    console.log('Uploading video of size', (size / 1000000), 'megabytes');

    // Get user data
    const user = await this.userClient.currentUser();
    // console.log(user);

    // Upload the video
    const media_id = await this.userClient.v1.uploadMedia(clipPath);
    // Tweet the video
    const newTweet = await this.userClient.v2.tweet(this.topClips[0].clip.title, {
      media: { media_ids: [media_id] }
    });
    console.log('Tweet ID:', newTweet);

    // Add the posted clip to the Set
    postedClips.add(clipID);
    // Then write the Set back to the file
    fs.appendFile(this.postedClipsFile, clipID + '\n', (err) => { if (err) throw err; });
    console.log('Wrote to file:', this.postedClipsFile);
    this.topClips.shift();

    // Fulfill the promise
    return newTweet;
  }
}

const twitterClients = ['XQC', 'NMPLOL', 'KAICENAT', 'HASANABI', 'MIZKIF'];
// not on Twitch ----> ADINROSS, ISHOWSPEED, JIDION, DESTINY
const streamers = ['xqc', 'nmplol', 'kaicenat', 'hasanabi', 'mizkif'];
const postTimes = ['0 18-20 * * *'];

// const xqc = new TwitchClipDownloader('XQC', 'xqc', '45 16 * * *', '0,25,50 18 * * *');
// const nmplol = new TwitchClipDownloader('NMPLOL', 'nmplol', '0 17 * * *', '5,30,55 18 * * *');
// const kaicenat = new TwitchClipDownloader('KAICENAT', 'kaicenat', '15 17 * * *', '10,35,59 18 * * *');
// const kaicenat2 = new TwitchClipDownloader('KAICENAT', 'kaicenat', '* * * * 1', '0 19 * * *'); // DEBUG
// const hasanabi = new TwitchClipDownloader('HASANABI', 'hasanabi', '30 17 * * *', '15,40 18 * * *');
// const hasanabi2 = new TwitchClipDownloader('HASANABI', 'hasanabi', '* * * * 1', '5 19 * * *'); // DEBUG
// const mizkif = new TwitchClipDownloader('MIZKIF', 'mizkif', '45 17 * * *', '20,45 18 * * *');
// const mizkif2 = new TwitchClipDownloader('MIZKIF', 'mizkif', '* * * * 1', '10 19 * * *'); // DEBUG

const xqc = new TwitchClipDownloader('XQC', 'xqc', '10 2 * * *', '0,25,50 3 * * *');
const nmplol = new TwitchClipDownloader('NMPLOL', 'nmplol', '20 2 * * *', '5,30,55 3 * * *');
const kaicenat = new TwitchClipDownloader('KAICENAT', 'kaicenat', '30 2 * * *', '10,35,59 3 * * *');
const kaicenat2 = new TwitchClipDownloader('KAICENAT', 'kaicenat', '* * * 1 *', '0 4 * * *'); // DEBUG
const hasanabi = new TwitchClipDownloader('HASANABI', 'hasanabi', '40 2 * * *', '15,40 3 * * *');
const hasanabi2 = new TwitchClipDownloader('HASANABI', 'hasanabi', '* * * 1 *', '5 4 * * *'); // DEBUG
const mizkif = new TwitchClipDownloader('MIZKIF', 'mizkif', '50 2 * * *', '20,45 3 * * *');
const mizkif2 = new TwitchClipDownloader('MIZKIF', 'mizkif', '* * * 1 *', '10 4 * * *'); // DEBUG

// DUBUG
// topClips.push({ localFilePath: './vids/Nmplol/AltruisticSparklingToadTBTacoRight-Yf15KIrP0XGmCa_m.mp4', clip: { id: '1' } });
// postToTwitter('test');
// END OF DEBUG