const { Client } = require('discord.js-selfbot-v13');
const { Pool } = require('pg');

const OWNER_IDS = [
  '664114670579351562',
  '914818330022535209'
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const client = new Client();
const PREFIX = '.';
const activeIntervals = new Map();
const responderCache = new Map();

function isAuthorized(userId) {
  return userId === client.user.id || OWNER_IDS.includes(userId);
}

function parseDelay(delayString) {
  let totalMilliseconds = 0;
  const regex = /(\d+)([smhd])/g;
  let match;

  while ((match = regex.exec(delayString.toLowerCase())) !== null) {
    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's': totalMilliseconds += value * 1000; break;
      case 'm': totalMilliseconds += value * 60 * 1000; break;
      case 'h': totalMilliseconds += value * 60 * 60 * 1000; break;
      case 'd': totalMilliseconds += value * 24 * 60 * 60 * 1000; break;
    }
  }

  if (totalMilliseconds === 0) {
    const fallbackValue = parseInt(delayString, 10);
    if (!isNaN(fallbackValue)) {
      return fallbackValue;
    }
  }

  return totalMilliseconds || 60000;
}

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auto_post_tasks (
        id SERIAL PRIMARY KEY,
        task_name VARCHAR(255),
        message_text TEXT,
        channel_id VARCHAR(255),
        delay_ms INTEGER,
        is_active BOOLEAN DEFAULT false,
        last_post_time TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Table auto_post_tasks checked/created');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS auto_responders (
        id SERIAL PRIMARY KEY,
        aliases TEXT,
        response_text TEXT,
        channel_id VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Table auto_responders checked/created');

  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

async function loadRespondersIntoCache() {
  try {
    const result = await pool.query('SELECT * FROM auto_responders WHERE is_active = true');
    responderCache.clear();
    result.rows.forEach(responder => {
      const channelId = responder.channel_id;
      if (!responderCache.has(channelId)) {
        responderCache.set(channelId, []);
      }
      responderCache.get(channelId).push(responder);
    });
    console.log(`Loaded ${result.rows.length} active responders into cache.`);
  } catch (error) {
    console.error('Error loading responders into cache:', error);
  }
}

async function startAutoPost(taskId) {
  try {
    const result = await pool.query('SELECT * FROM auto_post_tasks WHERE id = $1', [taskId]);
    
    if (result.rows.length === 0) {
      console.log(`Task dengan ID ${taskId} tidak ditemukan`);
      return false;
    }
    
    const task = result.rows[0];
    
    if (activeIntervals.has(taskId)) {
      clearInterval(activeIntervals.get(taskId));
    }
    
    const channel = await client.channels.fetch(task.channel_id).catch(() => null);
    if (!channel) {
      console.log(`Channel dengan ID ${task.channel_id} tidak ditemukan`);
      return false;
    }

    const postMessage = async () => {
      try {
        const finalContent = task.message_text || '';
        if (finalContent) {
            await channel.send(finalContent);
            console.log(`Pesan terkirim untuk task ${taskId} (${task.task_name})`);
        } else {
            console.log(`Task ${taskId} tidak memiliki konten untuk dikirim.`);
        }
        
        await pool.query(
          'UPDATE auto_post_tasks SET last_post_time = CURRENT_TIMESTAMP WHERE id = $1',
          [taskId]
        );
      } catch (error) {
        console.error(`Error mengirim pesan untuk task ${taskId}:`, error);
      }
    };

    postMessage();
    const interval = setInterval(postMessage, task.delay_ms);
    activeIntervals.set(taskId, interval);
    
    await pool.query(
      'UPDATE auto_post_tasks SET is_active = true WHERE id = $1',
      [taskId]
    );
    
    console.log(`Auto post untuk task ${taskId} (${task.task_name}) telah dimulai.`);
    return true;
  } catch (error) {
    console.error(`Error memulai auto post untuk task ${taskId}:`, error);
    return false;
  }
}

async function stopAutoPost(taskId) {
  try {
    if (activeIntervals.has(taskId)) {
      clearInterval(activeIntervals.get(taskId));
      activeIntervals.delete(taskId);
      
      await pool.query(
        'UPDATE auto_post_tasks SET is_active = false WHERE id = $1',
        [taskId]
      );
      
      console.log(`Auto post untuk task ${taskId} telah dihentikan`);
      return true;
    } else {
      console.log(`Task dengan ID ${taskId} tidak sedang aktif`);
      return false;
    }
  } catch (error) {
    console.error(`Error menghentikan auto post untuk task ${taskId}:`, error);
    return false;
  }
}

async function deleteTask(taskId) {
  try {
    await stopAutoPost(taskId);
    await pool.query('DELETE FROM auto_post_tasks WHERE id = $1', [taskId]);
    console.log(`Task dengan ID ${taskId} telah dihapus`);
    return true;
  } catch (error) {
    console.error(`Error menghapus task ${taskId}:`, error);
    return false;
  }
}

async function createResponder(aliases, responseText, channelId) {
  try {
    const aliasesJson = JSON.stringify(aliases);
    const result = await pool.query(
      'INSERT INTO auto_responders (aliases, response_text, channel_id) VALUES ($1, $2, $3) RETURNING id',
      [aliasesJson, responseText, channelId]
    );
    
    const newResponder = { id: result.rows[0].id, aliases, responseText, channelId };
    if (!responderCache.has(channelId)) {
      responderCache.set(channelId, []);
    }
    responderCache.get(channelId).push(newResponder);

    console.log(`Responder baru berhasil dibuat dengan ID: ${result.rows[0].id}`);
    return result.rows[0].id;
  } catch (error) {
    console.error('Error membuat responder baru:', error);
    return null;
  }
}

async function listResponders() {
  try {
    const result = await pool.query('SELECT * FROM auto_responders ORDER BY id');
    
    if (result.rows.length === 0) {
      return 'Tidak ada responder yang tersimpan.';
    }
    
    let responderList = '=== LIST AUTO RESPONDER ===\n';
    result.rows.forEach((responder, index) => {
      const status = responder.is_active ? '✅ AKTIF' : '❌ NON-AKTIF';
      const aliasList = JSON.parse(responder.aliases).join(', ');
      
      responderList += `${index + 1}. ID: ${responder.id} | Status: ${status}\n`;
      responderList += `   Aliases: ${aliasList}\n`;
      responderList += `   Channel: ${responder.channel_id}\n`;
      responderList += `   Response: ${responder.response_text.substring(0, 50)}${responder.response_text.length > 50 ? '...' : ''}\n\n`;
    });
    
    return responderList;
  } catch (error) {
    console.error('Error mengambil list responders:', error);
    return 'Error mengambil list responders.';
  }
}

async function stopResponder(responderId) {
  try {
    await pool.query('UPDATE auto_responders SET is_active = false WHERE id = $1', [responderId]);
    await loadRespondersIntoCache();
    console.log(`Responder dengan ID ${responderId} telah dihentikan`);
    return true;
  } catch (error) {
    console.error(`Error menghentikan responder ${responderId}:`, error);
    return false;
  }
}

async function startResponder(responderId) {
  try {
    await pool.query('UPDATE auto_responders SET is_active = true WHERE id = $1', [responderId]);
    await loadRespondersIntoCache();
    console.log(`Responder dengan ID ${responderId} telah dimulai`);
    return true;
  } catch (error) {
    console.error(`Error memulai responder ${responderId}:`, error);
    return false;
  }
}

async function deleteResponder(responderId) {
  try {
    await pool.query('DELETE FROM auto_responders WHERE id = $1', [responderId]);
    await loadRespondersIntoCache();
    console.log(`Responder dengan ID ${responderId} telah dihapus`);
    return true;
  } catch (error) {
    console.error(`Error menghapus responder ${responderId}:`, error);
    return false;
  }
}

async function listTasks() {
  try {
    const result = await pool.query('SELECT * FROM auto_post_tasks ORDER BY id');
    
    if (result.rows.length === 0) {
      return 'Tidak ada task yang tersimpan.';
    }
    
    let taskList = '=== LIST AUTO POST TASKS ===\n';
    result.rows.forEach((task, index) => {
      const status = task.is_active ? '✅ AKTIF' : '❌ NON-AKTIF';
      const lastPost = task.last_post_time ? new Date(task.last_post_time).toLocaleString('id-ID') : 'Belum pernah post';
      
      taskList += `${index + 1}. ID: ${task.id} | Nama: ${task.task_name} | Status: ${status}\n`;
      taskList += `   Pesan: ${task.message_text.substring(0, 50)}${task.message_text.length > 50 ? '...' : ''}\n`;
      taskList += `   Channel: ${task.channel_id}\n`;
      taskList += `   Delay: ${task.delay_ms}ms (${(task.delay_ms / 60000).toFixed(2)} menit)\n`;
      taskList += `   Last Post: ${lastPost}\n\n`;
    });
    
    return taskList;
  } catch (error) {
    console.error('Error mengambil list tasks:', error);
    return 'Error mengambil list tasks.';
  }
}

async function createTask(taskName, messageText, channelId, delayString) {
  try {
    const delayMs = parseDelay(delayString);
    
    const existingIdsResult = await pool.query('SELECT id FROM auto_post_tasks ORDER BY id');
    const existingIds = existingIdsResult.rows.map(row => row.id);
    let newId = 1;
    while (existingIds.includes(newId)) {
      newId++;
    }

    const result = await pool.query(
      'INSERT INTO auto_post_tasks (task_name, message_text, channel_id, delay_ms) VALUES ($1, $2, $3, $4) RETURNING id',
      [taskName, messageText, channelId, delayMs]
    );
    
    console.log(`Task baru berhasil dibuat dengan ID: ${result.rows[0].id}`);
    return result.rows[0].id;
  } catch (error) {
    console.error('Error membuat task baru:', error);
    return null;
  }
}

async function restartActiveTasks() {
  try {
    const result = await pool.query('SELECT * FROM auto_post_tasks WHERE is_active = true');
    
    if (result.rows.length > 0) {
      console.log(`Menemukan ${result.rows.length} task yang aktif. Memulai ulang...`);
      for (const task of result.rows) {
        await startAutoPost(task.id);
      }
      console.log('Semua task aktif telah dimulai ulang.');
    } else {
      console.log('Tidak ada task yang aktif untuk dimulai ulang.');
    }
  } catch (error) {
    console.error('Error memulai ulang task aktif:', error);
  }
}

async function handleCommands(message) {
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  
  try {
    switch (command) {
      case 'start': {
        if (args.length === 0) return message.reply('Usage: `.start <task_id>`');
        const taskId = parseInt(args[0]);
        if (isNaN(taskId)) return message.reply('ID task harus berupa angka.');
        
        const success = await startAutoPost(taskId);
        message.reply(success ? `✅ Task dengan ID ${taskId} telah dimulai.` : `❌ Gagal memulai task dengan ID ${taskId}.`);
        break;
      }
        
      case 'set': {
        if (args.length === 0) return message.reply('Usage: `.set <task_name>|<message_text>|<channel_id>|<delay>`');
        
        const fullArgs = args.join(' ');
        const parts = fullArgs.split('|');
        
        if (parts.length < 4) {
          return message.reply('Format tidak valid. Gunakan: `.set <task_name>|<message_text>|<channel_id>|<delay>`');
        }
        
        const [taskName, messageText, channelId, delayString] = parts;

        const taskId = await createTask(taskName.trim(), messageText.trim(), channelId.trim(), delayString.trim());
        if (taskId) {
          message.reply(`✅ Task baru berhasil dibuat dengan ID: ${taskId}. Gunakan \`.start ${taskId}\` untuk memulainya.`);
        } else {
          message.reply('❌ Gagal membuat task baru.');
        }
        break;
      }

      case 'addr': {
        if (args.length === 0) return message.reply('Usage: `.addr <alias1>/<alias2>/...|<response_text>|<channel_id>`');
        
        const fullArgs = args.join(' ');
        const parts = fullArgs.split('|');
        
        if (parts.length < 3) {
          return message.reply('Format tidak valid. Gunakan: `.addr <alias1>/<alias2>/...|<response_text>|<channel_id>`');
        }
        
        const [aliasString, responseText, channelId] = parts;
        const aliases = aliasString.split('/').map(a => a.trim());

        const responderId = await createResponder(aliases, responseText.trim(), channelId.trim());
        if (responderId) {
          message.reply(`✅ Responder baru berhasil dibuat dengan ID: ${responderId}.`);
        } else {
          message.reply('❌ Gagal membuat responder baru.');
        }
        break;
      }

      case 'listr': {
        const responderList = await listResponders();
        message.reply(`\`\`\`${responderList}\`\`\``);
        break;
      }
        
      case 'list': {
        const taskList = await listTasks();
        message.reply(`\`\`\`${taskList}\`\`\``);
        break;
      }

      case 'stopr': {
        if (args.length === 0) return message.reply('Usage: `.stopr <responder_id>`');
        const responderId = parseInt(args[0]);
        if (isNaN(responderId)) return message.reply('ID responder harus berupa angka.');
        
        const success = await stopResponder(responderId);
        message.reply(success ? `✅ Responder dengan ID ${responderId} telah dihentikan.` : `❌ Gagal menghentikan responder dengan ID ${responderId}.`);
        break;
      }
        
      case 'stop': {
        if (args.length === 0) return message.reply('Usage: `.stop <task_id>`');
        const taskId = parseInt(args[0]);
        if (isNaN(taskId)) return message.reply('ID task harus berupa angka.');
        
        const success = await stopAutoPost(taskId);
        message.reply(success ? `✅ Task dengan ID ${taskId} telah dihentikan.` : `❌ Gagal menghentikan task dengan ID ${taskId}.`);
        break;
      }

      case 'startr': {
        if (args.length === 0) return message.reply('Usage: `.startr <responder_id>`');
        const responderId = parseInt(args[0]);
        if (isNaN(responderId)) return message.reply('ID responder harus berupa angka.');
        
        const success = await startResponder(responderId);
        message.reply(success ? `✅ Responder dengan ID ${responderId} telah dimulai.` : `❌ Gagal memulai responder dengan ID ${responderId}.`);
        break;
      }
        
      case 'delr': {
        if (args.length === 0) return message.reply('Usage: `.delr <responder_id>`');
        const responderId = parseInt(args[0]);
        if (isNaN(responderId)) return message.reply('ID responder harus berupa angka.');
        
        const success = await deleteResponder(responderId);
        message.reply(success ? `✅ Responder dengan ID ${responderId} telah dihapus.` : `❌ Gagal menghapus responder dengan ID ${responderId}.`);
        break;
      }
        
      case 'delete': {
        if (args.length === 0) return message.reply('Usage: `.delete <task_id>`');
        const taskId = parseInt(args[0]);
        if (isNaN(taskId)) return message.reply('ID task harus berupa angka.');
        
        const success = await deleteTask(taskId);
        message.reply(success ? `✅ Task dengan ID ${taskId} telah dihapus.` : `❌ Gagal menghapus task dengan ID ${taskId}.`);
        break;
      }
        
      default:
        message.reply(`Command tidak dikenali. Command yang tersedia: \n**Auto Post:** \`.set\`, \`.start\`, \`.list\`, \`.stop\`, \`.delete\`\n**Responder:** \`.addr\`, \`.listr\`, \`.startr\`, \`.stopr\`, \`.delr\``);
    }
  } catch (error) {
    console.error('Error menangani command:', error);
    message.reply('Terjadi kesalahan saat mengeksekusi command.');
  }
}

async function handleResponders(message) {
  if (message.author.bot) return;

  const channelId = message.channel.id;
  if (!responderCache.has(channelId)) return;

  const responders = responderCache.get(channelId);
  const messageContent = message.content.toLowerCase();

  for (const responder of responders) {
    const aliases = JSON.parse(responder.aliases);
    for (const alias of aliases) {
      const regex = new RegExp(`\\b${alias}\\b`, 'i');
      if (regex.test(messageContent)) {
        try {
          await message.channel.send(responder.response_text);
          console.log(`Responder triggered for alias "${alias}" in channel ${channelId}`);
        } catch (err) {
          console.error(`Failed to send responder message: ${err}`);
        }
        return;
      }
    }
  }
}

client.on('ready', async () => {
  console.log(`${client.user.username} sudah online dan siap!`);
  
  await initDatabase();
  await loadRespondersIntoCache();
  await restartActiveTasks();
});

client.on('messageCreate', async (message) => {
  if (message.content.startsWith(PREFIX) && isAuthorized(message.author.id)) {
    await handleCommands(message);
    return;
  }

  if (message.author.bot) return;
  await handleResponders(message);
});

client.login(process.env.DISCORD_TOKEN);

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  activeIntervals.forEach((interval) => clearInterval(interval));
  await pool.end();
  client.destroy();
  process.exit(0);
});
