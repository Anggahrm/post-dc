const { Client, WebEmbed } = require('discord.js-selfbot-v13');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const client = new Client();
const PREFIX = '.';
const activeIntervals = new Map();

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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        embed_data TEXT
      )
    `);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
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
        let finalContent = task.message_text || '';

        if (task.embed_data) {
          const embedData = JSON.parse(task.embed_data);
          const embed = new WebEmbed()
            .setTitle(embedData.title || null)
            .setDescription(embedData.description || null)
            .setColor(embedData.color || null);
          
          finalContent += embed.toString();
        }

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
    
    console.log(`Auto post untuk task ${taskId} (${task.task_name}) telah dimulai. Pesan pertama dikirim, selanjutnya setiap ${task.delay_ms}ms.`);
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
      const hasEmbed = task.embed_data ? ' (Dengan Embed)' : '';
      
      taskList += `${index + 1}. ID: ${task.id} | Nama: ${task.task_name} | Status: ${status}${hasEmbed}\n`;
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

async function createTask(taskName, messageText, channelId, delayString, embedData) {
  try {
    const delayMs = parseDelay(delayString);
    
    const existingIdsResult = await pool.query('SELECT id FROM auto_post_tasks ORDER BY id');
    const existingIds = existingIdsResult.rows.map(row => row.id);
    let newId = 1;
    while (existingIds.includes(newId)) {
      newId++;
    }

    const result = await pool.query(
      'INSERT INTO auto_post_tasks (task_name, message_text, channel_id, delay_ms, embed_data) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [taskName, messageText, channelId, delayMs, embedData]
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

client.on('ready', async () => {
  console.log(`${client.user.username} sudah online dan siap!`);
  
  await initDatabase();
  await restartActiveTasks();
});

client.on('messageCreate', async (message) => {
  if (message.author.id !== client.user.id) return;
  if (!message.content.startsWith(PREFIX)) return;
  
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
          return message.reply('Format tidak valid. Gunakan: `.set <task_name>|<message_text>|<channel_id>|<delay>`\nContoh tanpa embed: `.set Jualan|# Sell Script|1364460677967908960|1h 30m`\nContoh dengan embed: `.set Promosi|# Cek promosi!|1364460677967908960|2h|Judul Embed|Deskripsi Embed|#00FF00`');
        }
        
        const [taskName, messageText, channelId, delayString, embedTitle, embedDescription, embedColor] = parts;
        
        let embedData = null;
        if (parts.length > 4) {
          embedData = JSON.stringify({
            title: embedTitle && embedTitle !== '-' ? embedTitle.trim() : null,
            description: embedDescription && embedDescription !== '-' ? embedDescription.trim() : null,
            color: embedColor && embedColor !== '-' ? embedColor.trim() : null
          });
        }

        const taskId = await createTask(taskName.trim(), messageText.trim(), channelId.trim(), delayString.trim(), embedData);
        if (taskId) {
          message.reply(`✅ Task baru berhasil dibuat dengan ID: ${taskId}. Gunakan \`.start ${taskId}\` untuk memulainya.`);
        } else {
          message.reply('❌ Gagal membuat task baru.');
        }
        break;
      }
        
      case 'list': {
        const taskList = await listTasks();
        message.reply(`\`\`\`${taskList}\`\`\``);
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
        
      case 'delete': {
        if (args.length === 0) return message.reply('Usage: `.delete <task_id>`');
        const taskId = parseInt(args[0]);
        if (isNaN(taskId)) return message.reply('ID task harus berupa angka.');
        
        const success = await deleteTask(taskId);
        message.reply(success ? `✅ Task dengan ID ${taskId} telah dihapus.` : `❌ Gagal menghapus task dengan ID ${taskId}.`);
        break;
      }
        
      default:
        message.reply(`Command tidak dikenali. Command yang tersedia: \`.set\`, \`.start\`, \`.list\`, \`.stop\`, \`.delete\``);
    }
  } catch (error) {
    console.error('Error menangani command:', error);
    message.reply('Terjadi kesalahan saat mengeksekusi command.');
  }
});

client.login(process.env.DISCORD_TOKEN);

process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  activeIntervals.forEach((interval) => clearInterval(interval));
  await pool.end();
  client.destroy();
  process.exit(0);
});
