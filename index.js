const axios = require("axios");
const express = require("express");
const app = express();

require('dotenv').config();

// Замените следующими значениями из настроек вашего приложения в AmoCRM
const CLIENT_ID = process.env.AMO_CLIENT_ID;
const CLIENT_SECRET = process.env.AMO_CLIENT_SECRET;
const REDIRECT_URI = process.env.AMO_REDIRECT_URI;

// Функция для обновления токенов
async function refreshToken(refreshToken) {
  try {
    const response = await axios.post("https://your-domain.amocrm.com/oauth2/access_token", {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      redirect_uri: REDIRECT_URI,
    });

    return response.data;
  } catch (error) {
    console.error("Ошибка обновления токенов:", error.response.data);
  }
}

// Функция для получения токенов по коду авторизации
async function getTokens(authCode) {
  try {
    const response = await axios.post("https://your-domain.amocrm.com/oauth2/access_token", {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: REDIRECT_URI,
    });

    return response.data;
  } catch (error) {
    console.error("Ошибка получения токенов:", error.response.data);
  }
}

// Обработчик кода авторизации в redirect_uri
app.get("/auth/callback", async (req, res) => {
  const authCode = req.query.code;

  try {
    const tokens = await getTokens(authCode);
    // Сохраните полученные токены в вашей системе (например, в базе данных)
    console.log("Получены токены:", tokens);
    res.send("Авторизация прошла успешно");
  } catch (error) {
    console.error("Ошибка обработки кода авторизации:", error);
    res.status(500).send("Ошибка обработки кода авторизации");
  }
});

// Здесь начинается основной код скрипта
const { Client } = require('amocrm-js');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');

const client = new Client({
  domain: process.env.AMO_DOMAIN,
  auth: {
    client_id: process.env.AMO_CLIENT_ID,
    client_secret: process.env.AMO_CLIENT_SECRET,
    redirect_uri: process.env.AMO_REDIRECT_URI,
    server: {
      port: process.env.AMO_SERVER_PORT,
    },
  },
});

client.connection.setTokens({
    access_token: process.env.AMO_ACCESS_TOKEN,
    refresh_token: process.env.AMO_REFRESH_TOKEN,
    expires_in: 86400, // Текущее время до истечения токена доступа
  });
  
  client.connection.on('connectionError', () => {
    console.error('Произошла ошибка соединения');
  });
  
  client.connection.on('authServer:code', () => {
    console.log('Авторизация прошла успешно!');
  });
  
  client.connection.on('tokensUpdated', (tokens) => {
    // Здесь вы можете сохранить обновленные токены в файл .env или базу данных
    console.log('Токены обновлены:', tokens);
  });

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

async function getLeads() {
  const pipelineId = process.env.AMO_PIPELINE_ID;
  const pipelineStatusId = process.env.AMO_PIPELINE_STATUS_ID;
  const query = {
    filter: {
      statuses: {
        id: pipelineStatusId,
      },
      pipeline_id: pipelineId,
    },
  };
  try {
    const response = await client.leads.list(query);
    const leads = response._embedded.leads;
    return leads;
  } catch (error) {
    console.error(error);
    throw error;
  }
}

async function moveLeadToNewRequestsStatus(lead) {
  const pipelineId = process.env.AMO_PIPELINE_ID;
  const newStatusId = process.env.AMO_PIPELINE_NEW_STATUS_ID;
  const query = {
    update: [{ id: lead.id, status_id: newStatusId, pipeline_id: pipelineId }],
  };
  const response = await client.leads.update(query);
  return response;
}

async function findActiveLeadsWithContact(lead) {
  const contact = lead._embedded.contacts[0];
  const contactPhone = contact.phone || '';
  const phonePattern = contactPhone.replace(/[\s()-]/g, '');
  const allPipelinesResponse = await client.pipelines.list();
  const pipelines = allPipelinesResponse._embedded.pipelines;

  const activeLeads = [];

  for (const pipeline of pipelines) {
    const query = {
      filter: {
        statuses: {
          id: pipeline.statuses.map((s) => s.id),
        },
        contacts: {
          query: phonePattern,
          type: 'phone',
        },
      },
    };
    const leadsResponse = await client.leads.list(query);
    const activeLead = leadsResponse._embedded.leads[0];
    if (activeLead) {
      activeLeads.push(activeLead);
    }
  }

  return activeLeads;
}

async function mergeLeads(lead, existingLead) {
  const existingContact = existingLead._embedded.contacts[0];
  const contactIds = lead._embedded.contacts.map((c) => c.id);
  const mergedLead = await client.leads.merge(lead.id, existingLead.id);
  const mergedContact = await client.contacts.merge(contactIds, existingContact.id);

  await moveLeadToNewRequestsStatus(mergedLead);

  return mergedLead;
}

async function sendNotification(lead) {
    const message = `Сделка "${lead.name}" была успешно обработана и перемещена в статус "Новые заявки"`;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    await bot.sendMessage(chatId, message);
  }
  
  async function processLeads() {
    try {
      const leads = await getLeads();
      if (!leads.length) {
        throw new Error('Нет сделок для обработки');
      }
  
      for (const lead of leads) {
        const activeLeads = await findActiveLeadsWithContact(lead);
  
        if (activeLeads.length) {
          for (const activeLead of activeLeads) {
            console.log(`Объединяем сделки ${lead.id} и ${activeLead.id}`);
  
            try {
              await mergeLeads(lead, activeLead);
              console.log(`Сделки ${lead.id} и ${activeLead.id} успешно объединены`);
              await sendNotification(lead);
            } catch (err) {
              console.log(`Ошибка при объединении сделок ${lead.id} и ${activeLead.id}: ${err.message}`);
            }
          }
        } else {
          try {
            await moveLeadToNewRequestsStatus(lead);
            console.log(`Сделка ${lead.id} успешно перемещена в статус "новые заявки"`);
            await sendNotification(lead);
          } catch (err) {
            console.log(`Ошибка при перемещении сделки ${lead.id} в статус "новые заявки": ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.log(`Ошибка при обработке сделок: ${err.message}`);
    }
  }
  
  // Запуск скрипта каждые 10 минут
  schedule.scheduleJob('*/10 * * * *', processLeads);
  
  // Обработчик команды /merge для ручного запуска скрипта
  bot.onText(/\/merge/, processLeads);
  
  app.listen(3000, () => {
    console.log("Сервер запущен на порту 3000");
  });
