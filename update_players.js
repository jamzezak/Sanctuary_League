// Save as update_players.js
require('dotenv').config();  // Load environment variables from .env file

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const fs = require('fs');
const parse = require('csv-parse/sync').parse;

const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRZ7vNRxpMdHCpFpp_DCkc0HkubuIoQ0nlppTfYHcQrsWwKcH8Zin_QTePZnVCX8g1tSKa-Hj4qZZIo/pub?output=csv';
const API_KEY = process.env.RIOT_API_KEY;  // Access the API key from the .env file
const REGION_ROUTING = 'americas';
const REGION_PLATFORM = 'na1';
const DDRAGON_BASE_URL = 'https://ddragon.leagueoflegends.com/cdn';

async function fetchCSV(url) {
    const res = await fetch(url);
    return res.text();
}

async function fetchRiotApi(url) {
    const res = await fetch(`${url}?api_key=${API_KEY}`);
    if (!res.ok) return null;
    return res.json();
}

async function main() {
    const csv = await fetchCSV(GOOGLE_SHEET_CSV_URL);
    const records = parse(csv, { columns: true, skip_empty_lines: true });

    const players = [];

    for (const row of records) {
        const ign = (row['In-Game Name'] || '').trim();
        const [name, tag] = ign.split('#');
        if (!name || !tag) {
            console.log('  Skipping row, invalid name/tag:', ign);
            continue;
        }
        // Parse roles robustly
        const roles = (row['Preferred Role(s)'] || '')
            .split(',')
            .map(r => r.trim())
            .filter(Boolean);

        console.log(`Fetching data for ${name}#${tag}...`);

        // Fetch Riot account
        const account = await fetchRiotApi(`https://${REGION_ROUTING}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
        if (!account) {
            console.log(`  Could not fetch account for ${name}#${tag}`);
            continue;
        }

        // Fetch Summoner info
        const summoner = await fetchRiotApi(`https://${REGION_PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}`);
        if (!summoner) {
            console.log(`  Could not fetch summoner for ${name}#${tag}`);
            continue;
        }

        // Fetch Rank info
        const ranks = await fetchRiotApi(`https://${REGION_PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-summoner/${summoner.id}`);
        let soloRank = { tier: "Unranked", rank: "", leaguePoints: 0 };
        if (Array.isArray(ranks)) {
            const solo = ranks.find(r => r.queueType === "RANKED_SOLO_5x5");
            if (solo) {
                soloRank = {
                    tier: solo.tier,
                    rank: solo.rank,
                    leaguePoints: solo.leaguePoints
                };
            }
        }

        // Fetch Champion Masteries
        const masteries = await fetchRiotApi(`https://${REGION_PLATFORM}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${account.puuid}`);
        let topChamps = [];
        let highestMasteryChamp = null;
        if (Array.isArray(masteries) && masteries.length > 0) {
            // Load champion data from Data Dragon (once)
            if (!global.championData) {
                const versionRes = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
                const versions = await versionRes.json();
                const latestVersion = versions[0];
                const champRes = await fetch(`https://ddragon.leagueoflegends.com/cdn/${latestVersion}/data/en_US/champion.json`);
                const champData = await champRes.json();
                global.championData = {};
                Object.values(champData.data).forEach(champ => {
                    global.championData[champ.key] = champ;
                });
                global.latestDDragonVersion = latestVersion;
            }
            // Top 5 masteries
            topChamps = masteries.slice(0, 5).map(m => {
                const champ = global.championData[m.championId];
                return champ ? {
                    name: champ.name,
                    img: `https://ddragon.leagueoflegends.com/cdn/${global.latestDDragonVersion}/img/champion/${champ.image.full}`,
                    points: m.championPoints
                } : null;
            }).filter(Boolean);
            // Highest mastery champ
            const highest = masteries[0];
            const champ = global.championData[highest.championId];
            if (champ) {
                highestMasteryChamp = {
                    name: champ.name,
                    points: highest.championPoints
                };
            }
        }

        players.push({
            name: name.trim(),
            tag: tag.trim(),
            role: roles,
            summonerLevel: summoner.summonerLevel,
            profileIconId: summoner.profileIconId,
            soloRank, // <-- add this line
            topChamps,
            highestMasteryChamp
        });

        // Respect Riot API rate limits
        await new Promise(res => setTimeout(res, 1200));
    }

    fs.writeFileSync('players.json', JSON.stringify(players, null, 2));
    console.log('Done! Saved to players.json');
}

main();