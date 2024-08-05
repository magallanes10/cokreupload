const axios = require('axios');
const cheerio = require('cheerio');
const qs = require('qs');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const express = require('express');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const app = express();
const PORT = 3000;

const axiosInstance = wrapper(axios.create({
    jar: new CookieJar(),
    withCredentials: true,
    headers: {
        'User-Agent': 'Mozilla/5.0'
    }
}));

const libraryPath = path.join(__dirname, 'library.json');
let library = [];
if (fs.existsSync(libraryPath)) {
    library = JSON.parse(fs.readFileSync(libraryPath, 'utf8'));
} else {
    fs.writeFileSync(libraryPath, JSON.stringify(library, null, 2));
}

async function downloadAudio(url, outputPath) {
    const response = await axios({
        url: url,
        method: 'GET',
        responseType: 'stream'
    });

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

function deleteFile(filePath) {
    fs.unlink(filePath, (err) => {
        if (err) {
            console.error(`Error deleting file ${filePath}:`, err);
        } else {
            console.log(`File ${filePath} deleted successfully.`);
        }
    });
}

async function getUploadUrl(instance) {
    const response = await instance.get('/');
    const $ = cheerio.load(response.data);
    return $('#form-upload').attr('action');
}

async function uploadFile(filePath, uploadUrl, instance) {
    const formData = new FormData();
    formData.append('USERFILE', fs.createReadStream(filePath));

    const response = await instance.post(uploadUrl, formData, {
        headers: formData.getHeaders(),
    });
    return response.data;
}

async function getCjointLink(uploadResponse) {
    const $ = cheerio.load(uploadResponse);
    const link = $('.share_url a').attr('href');
    console.log('Cjoint link:', link);
    return link;
}

async function getFinalUrl(cjointLink) {
    const instance = axios.create({
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
        baseURL: cjointLink,
    });

    try {
        const htmlResponse = await instance.get('/');
        const html$ = cheerio.load(htmlResponse.data);
        const shareUrl = html$('.share_url a').attr('href');
        const finalUrl = `https://www.cjoint.com${shareUrl.split('"')[0]}`;
        return finalUrl;
    } catch (error) {
        console.error('Error getting final URL:', error);
        throw error;
    }
}

async function fetchFormAndSubmit(urlsong, title) {
    try {
        const getResponse = await axiosInstance.get('https://geodash.click/dashboard/reupload/songAdd.php');
        const $ = cheerio.load(getResponse.data);

        const formData = new URLSearchParams();
        formData.append('url', urlsong);
        formData.append('title', title);

        const postResponse = await axiosInstance.post('https://geodash.click/dashboard/reupload/songAdd.php', formData.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const $post = cheerio.load(postResponse.data);
        let responseJson = {};

        const successMessage = $post('p:contains("Song Reuploaded:")').text();
        if (successMessage) {
            const songId = successMessage.match(/Song Reuploaded: (\d+)/)[1];
            responseJson.songid = songId;
            library.push({ title, url: urlsong, songId });
            fs.writeFileSync(libraryPath, JSON.stringify(library, null, 2));
        } else {
            const errorMessage = $post('p:contains("An error has occured:")').text();
            if (errorMessage.includes("-3")) {
                responseJson.error = "This song has been reuploaded already";
            } else if (errorMessage.includes("-2")) {
                responseJson.error = "Invalid URL";
            } else {
                responseJson.error = "An unknown error has occurred";
            }
        }

        return responseJson;
    } catch (error) {
        console.error('An error occurred while fetching or submitting the form:', error.response ? error.response.data : error.message);
        throw error;
    }
}

async function loginAndFetchHtml(username, password) {
    try {
        const loginResponse = await axiosInstance.post('https://geodash.click/dashboard/login/login.php', qs.stringify({
            userName: username,
            password: password
        }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            maxRedirects: 1
        });

        if (loginResponse.status === 200) {
            console.log('Login successful');
            startServer();
        } else {
            console.log('Login failed with status code:', loginResponse.status);
        }
    } catch (error) {
        console.error('An error occurred during login:', error.response ? error.response.data : error.message);
    }
}

function startServer() {
    app.get('/jonell/upload', async (req, res) => {
        const { url, title } = req.query;

        if (!url || !title) {
            return res.status(400).json({ error: 'Missing url or title' });
        }

        const tiktokRegex = /^https:\/\/.*tiktok\.com/;

        try {
            if (tiktokRegex.test(url)) {
                console.log(`TikTok URL detected: ${url}`);
                const result = await fetchFormAndSubmit(url, title);
                res.json(result);
            } else {
                console.log(`Fetching audio from URL: ${url}`);
                const response = await axios.get(`http://158.101.198.227:8761/yt?url=${url}&version=v3`);
                const audioUrl = response.data.audio;

                const timestamp = Date.now();
                const outputPath = path.join(__dirname, `audio-${timestamp}.mp3`);
                await downloadAudio(audioUrl, outputPath);

                console.log('Audio downloaded, starting upload...');
                const instance = axios.create({
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    },
                    baseURL: 'https://www.cjoint.com/',
                });

                const uploadUrl = await getUploadUrl(instance);
                const uploadResponse = await uploadFile(outputPath, uploadUrl, instance);
                const cjointLink = await getCjointLink(uploadResponse);
                const finalUrl = await getFinalUrl(cjointLink);

                const result = await fetchFormAndSubmit(finalUrl, title);
                res.json(result);

                deleteFile(outputPath);
            }
        } catch (error) {
            console.error('An error occurred in the /jonell/upload route:', error.response ? error.response.data : error.message);
            res.status(500).json({ error: 'Failed to submit form' });
        }
    });

    app.get('/library', (req, res) => {
        res.json(library);
    });

    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}

loginAndFetchHtml('harold10', 'harold10');
