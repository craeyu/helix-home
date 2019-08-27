/*
    0 -> node path
    1 -> app path
    2 -> owner name
    3 -> repo name
    4 -> path name (default to root)
*/
const minimist = require('minimist');

let args = minimist(process.argv.slice(2), {  
    alias: {
        o: 'owner',
        r: 'repo',
        j: 'json',
    },
    default: {
        o: 'craeyu',
        r: 'helix-home',
        j: false,
    },
});

const owner = args['o'];
const repo = args['r'];
const json = args['j'];

const http = require('http');
const request = require("request-promise-native");
const dotenv = require('dotenv');
dotenv.config();

const Octokit = require('@octokit/rest');
const octokit = new Octokit({
    auth: process.env.HELIX_SCANNER_GITHUB_AUTH_TOKEN,
    baseUrl: 'https://api.github.com',
    log: {
        debug: () => {},
        info: () => {},
        warn: console.warn,
        error: console.error
    },
    request: {
        agent: undefined,
        fetch: undefined,
        timeout: 0
    }
});

const pg = require('pg');
const config = {
    host: process.env.HELIX_SCANNER_POSTGRESQL_DB_HOST,
    user: process.env.HELIX_SCANNER_POSTGRESQL_DB_USER,     
    password: process.env.HELIX_SCANNER_POSTGRESQL_DB_PASSWORD,
    database: process.env.HELIX_SCANNER_POSTGRESQL_DB_NAME,
    port: 5432,
    ssl: true
};
const client = new pg.Client(config);

const hostname = '127.0.0.1';
const server_port = 3001;

const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Hello World\n');
});

const base_url =  `http://localhost:3000/`;

const revision = require('child_process')
.execSync('git rev-parse HEAD')
.toString().trim()

let existingTableNames = {}

const createDefaultTable = async (tableName) => {
    const createTableQuery = `CREATE TABLE IF NOT EXISTS ${tableName} (
        path    text    PRIMARY KEY
    );`
    console.log(`Preparing to execute table default creation query ${createTableQuery}`)
    try {
        existingTableNames[tableName] = ['path']
        await client.query(createTableQuery)
    } catch (err) {
        throw err
    }
}

const updateTextColumns = async (tableName, key) => {
    const updateColumnQuery = `ALTER TABLE ${tableName}
        ADD COLUMN IF NOT EXISTS ${key} text;`
    console.log(`Preparing to execute column insertion query ${updateColumnQuery}`)
    try {
        existingTableNames[tableName].push(key)
        await client.query(updateColumnQuery)
    } catch (err) {
        console.error(`Error executing column update query '${insertDataQuery}': `, err)
        throw err
    }
}

const mergeKeyandValue = async (keys) => {
    const strs = []
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i]
        strs.push(`${key} = EXCLUDED.${key}`)
    }
    return strs.join(', ')
}

const execQuery = async (tableName, filePath, file_entries) => {
    let current_columns = existingTableNames[tableName]
    Object.keys(file_entries).map(key => {
        if (!current_columns.includes(key)) {
            try {
                updateTextColumns(tableName, key)
            } catch (err) {
                throw err;
            }
        }
    })
    const query_schema = current_columns.join(', ')
    let currentValues = []
    for (let column of current_columns) {
        if (column === 'path') {
            currentValues.push(filePath)
        } else {
            currentValues.push(file_entries[column] ? JSON.stringify(file_entries[column]) : 'NULL')
        }
    }
    const valueField = currentValues .join('\', \'')
    const onConflictField = await mergeKeyandValue(current_columns)
    const insertDataQuery = `INSERT INTO ${tableName} (${query_schema}) VALUES ('${valueField}')
    ON CONFLICT (path) DO UPDATE SET ${onConflictField};`;
    console.log(`Preparing to execute data insertion query ${insertDataQuery}`)
    try {
        await client.query(insertDataQuery)
    } catch (err) {
        console.error(`Error executing database query '${insertDataQuery}': `, err)
        throw err;
    }
}

const updateJSONBColumn = (tableName) => {
    const column_name = 'entries'
    const updateColumnQuery = `ALTER TABLE ${tableName}
        ADD COLUMN IF NOT EXISTS ${column_name} JSONB;`
    console.log(`Preparing to execute column insertion query ${updateColumnQuery}`)
    client.query(updateColumnQuery)
        .catch(err => console.log(err))
    existingTableNames[tableName].push(column_name)
}

const execJSONQuery = (tableName, path, entries) => {
    if (!existingTableNames[tableName].includes('entries'))
        updateJSONBColumn(tableName)
    const stringifiedEntries = JSON.stringify(entries)
    const insertDataQuery = `INSERT INTO ${tableName} (path, entries) VALUES ('${path}', '${stringifiedEntries}')
        ON CONFLICT (path) DO UPDATE SET entries = EXCLUDED.entries;`;
    console.log(`Preparing to execute data insertion query ${insertDataQuery}`)
    client.query(insertDataQuery)
        .catch(err => {
            console.log(`Error executing database query '${insertDataQuery}': `, err)
        })
}

const scanGithub = async () => octokit.git.getTree({
    owner: owner,
    repo: repo,
    tree_sha: revision,
    recursive: 1,
})

server.listen(server_port, hostname, async () => {
    console.log(`Server running at http://${hostname}:${server_port}/`);
    existingTableNames = {}
    try {
        await client.connect();
        console.log('PostgresDB connected.');
    } catch (err) {
        console.err(err);
        return;
    }
    const { data : { tree }} = await scanGithub();
    if (tree.length === 0) {
        return;
    }

    const filePaths = tree.filter(obj => obj.type === 'blob' && !obj.path.startsWith('.github') && obj.path.endsWith('.md')).map(file => file.path);
    const promises = filePaths.map(filePath => request({uri: base_url.concat(filePath.replace('.md', '.idx.json')), json: true}));
    let results = [];
    try {
        results = await Promise.all(promises);
    } catch (err) {
        console.error('Error in waiting for all content querying promises from pipeline to resolve', err);
        return;
    }

    const missingTableNames = new Set();
    for (const content of results) {
        Object.keys(content).forEach((tableName) => {
            if (!(tableName in existingTableNames)) {
                missingTableNames.add(tableName);
            }
        });
    }
    try {
        await Promise.all(Array.from(missingTableNames).map(createDefaultTable));
    } catch (err) {
        console.error(err);
        return;
    }

    // for (let i = 0; i < results.length; ++i) {
    //     const content = results[i]
    //     const path = `/${owner}/${repo}/${filePaths[i]}`
    //     Object.keys(content).map(tableName => {
    //         const { entries } = content[tableName]
    //         if (!(tableName in existingTableNames)) {
    //             try {
    //                 createDefaultTable(tableName)
    //             } catch (err) {
    //                 console.err(err)
    //             }
    //         }
    //         if (json === true) {
    //             execJSONQuery(tableName, path, entries)
    //         } else {
    //             execQuery(tableName, path, entries)
    //         }
    //     })
    // }
});