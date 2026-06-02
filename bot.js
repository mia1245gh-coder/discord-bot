require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const { addEvent, makeId, readState, updateState } = require('./storage');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const LOG_CHANNEL_ID = process.env.APPLICATION_LOG_CHANNEL_ID;
const RESULT_CHANNEL_ID = process.env.APPLICATION_RESULT_CHANNEL_ID || LOG_CHANNEL_ID;
const CALL_CHANNEL_ID = process.env.CALL_CHANNEL_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || '';
const PORT = Number(process.env.PORT || 3000);

const PANEL_IMAGE_URL = process.env.PANEL_IMAGE_URL || '';
const BRAND_ICON_URL = process.env.BRAND_ICON_URL || '';
const LOCAL_PANEL_IMAGE = path.join(__dirname, 'assets', 'reinhard-panel.gif');
const LOCAL_BRAND_ICON = path.join(__dirname, 'assets', 'reinhard-avatar.png');
const PANEL_ATTACHMENT_NAME = 'reinhard-panel.gif';
const BRAND_ATTACHMENT_NAME = 'reinhard-avatar.png';
const FAMILY_NAME = process.env.FAMILY_NAME || 'Reinhard';
const TICKET_NAME_PREFIX = process.env.TICKET_NAME_PREFIX || 'тикет';
const RECRUITER_ROLE_IDS = splitIds(process.env.RECRUITER_ROLE_IDS);
const ADMIN_ROLE_IDS = splitIds(process.env.ADMIN_ROLE_IDS);
const RECRUIT_TEMPLATES = [
  {
    value: 'call_invite',
    label: '01 | Приглашение на обзвон',
    description: 'Предварительное одобрение заявки',
    text: () => [
      'Приветствую.',
      '',
      'Ваша заявка была рассмотрена и предварительно одобрена.',
      'Когда вам будет удобно пройти обзвон?'
    ].join('\n')
  },
  {
    value: 'call_time',
    label: '02 | Уточнение времени',
    description: 'Уточнить удобное время сегодня',
    text: () => 'Уточните, пожалуйста, в какое время сегодня вы будете готовы пройти обзвон.'
  },
  {
    value: 'bad_answer',
    label: '03 | Некорректный ответ',
    description: 'Открывает поле для пункта заявки',
    editable: true
  },
  {
    value: 'reject_note',
    label: '04 | Заявка отклонена',
    description: 'Текст с причиной отказа',
    text: () => [
      'Приветствую.',
      '',
      'Ваша заявка была отклонена.',
      'Причина: [указать причину].',
      '',
      'Вы сможете подать новую заявку после исправления указанных недочетов.'
    ].join('\n')
  },
  {
    value: 'no_show',
    label: '05 | Не вышел на связь',
    description: 'Кандидат не пришел на обзвон',
    text: () => [
      'Приветствую.',
      '',
      'Вы не вышли на связь для прохождения обзвона.',
      'Если вы всё еще заинтересованы во вступлении, сообщите актуальное время, когда сможете пройти обзвон.'
    ].join('\n')
  },
  {
    value: 'call_passed',
    label: '06 | Успешный обзвон',
    description: 'Кандидат прошел обзвон',
    text: ({ actor }) => [
      'Приветствую.',
      '',
      'Вы успешно прошли обзвон.',
      `Ожидайте дальнейших кординаций от <@${actor.id}>`
    ].join('\n')
  }
];

if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing. Create .env or Railway variables.');
  process.exit(1);
}

if (!CLIENT_ID) {
  console.error('DISCORD_CLIENT_ID is missing. Add application client id to .env/Railway.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

startHttpApi();

client.once('ready', async () => {
  console.log(`ReinhardBot logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error('Failed to register Discord commands.', error);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
      return;
    }

    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    }
  } catch (error) {
    console.error(error);
    await safeReply(interaction, {
      content: 'Произошла ошибка. Проверьте логи бота.',
      ephemeral: true
    });
  }
});

client.login(TOKEN).catch(error => {
  console.error('Discord login failed.', error);
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('recruit-panel')
      .setDescription('Опубликовать панель подачи заявки в текущем канале.'),
    new SlashCommandBuilder()
      .setName('recruit-open')
      .setDescription('Открыть или закрыть набор.')
      .addBooleanOption(option =>
        option.setName('status')
          .setDescription('true = набор открыт, false = набор закрыт')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('recruit-stats')
      .setDescription('Показать статистику заявок.'),
    new SlashCommandBuilder()
      .setName('recruit-find')
      .setDescription('Найти историю заявок пользователя.')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('Пользователь Discord')
          .setRequired(true)
      )
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`Registered ${commands.length} guild commands.`);
    return;
  }

  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log(`Registered ${commands.length} global commands.`);
}

async function handleCommand(interaction) {
  if (interaction.commandName === 'recruit-panel') {
    if (!canManageRecruiting(interaction.member)) {
      await interaction.reply({ content: 'Нет доступа к настройке панели.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const panelPayload = {
      embeds: panelEmbeds(),
      files: panelFiles(),
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('recruit:open-modal')
          .setPlaceholder('Открыть форму вступления')
          .addOptions({
            label: 'Подать тикет',
            value: 'apply',
            description: 'Заполнить анкету кандидата'
          })
      )]
    };

    try {
      await interaction.channel.send(panelPayload);
    } catch (error) {
      if (!panelPayload.files.length) {
        throw error;
      }

      console.warn('Failed to send panel with local files, retrying without attachments.', error);
      await interaction.channel.send({
        embeds: panelEmbeds(false),
        components: panelPayload.components
      });
    }

    await interaction.editReply({ content: 'Панель заявок опубликована.' });
    return;
  }

  if (interaction.commandName === 'recruit-open') {
    if (!canManageRecruiting(interaction.member)) {
      await interaction.reply({ content: 'Нет доступа к настройке набора.', ephemeral: true });
      return;
    }

    const status = interaction.options.getBoolean('status', true);
    updateState(state => {
      state.settings.recruitmentOpen = status;
      addEvent(state, {
        type: status ? 'recruitment-opened' : 'recruitment-closed',
        actorId: interaction.user.id,
        actorTag: interaction.user.tag
      });
    });

    await interaction.reply({
      content: status ? 'Набор открыт.' : 'Набор закрыт.',
      ephemeral: true
    });
    return;
  }

  if (interaction.commandName === 'recruit-stats') {
    const state = readState();
    const counts = countStatuses(state.applications);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`${FAMILY_NAME} | Статистика заявок`)
        .setColor(0x2dd4bf)
        .addFields(
          { name: 'Всего', value: String(state.applications.length), inline: true },
          { name: 'Новые', value: String(counts.new), inline: true },
          { name: 'На рассмотрении', value: String(counts.review), inline: true },
          { name: 'Обзвон', value: String(counts.call), inline: true },
          { name: 'Приняты', value: String(counts.accepted), inline: true },
          { name: 'Отказы', value: String(counts.rejected), inline: true }
        )],
      ephemeral: true
    });
    return;
  }

  if (interaction.commandName === 'recruit-find') {
    const user = interaction.options.getUser('user', true);
    const state = readState();
    const items = state.applications.filter(item => item.userId === user.id).slice(0, 5);
    await interaction.reply({
      embeds: [historyEmbed(user, items)],
      ephemeral: true
    });
  }
}

async function handleButton(interaction) {
  if (interaction.customId === 'recruit:open-modal') {
    const state = readState();
    if (!state.settings.recruitmentOpen) {
      await interaction.reply({
        content: 'Набор сейчас закрыт. Попробуйте позже.',
        ephemeral: true
      });
      return;
    }

    const active = state.applications.find(item =>
      item.userId === interaction.user.id &&
      ['new', 'review', 'call'].includes(item.status)
    );

    if (active) {
      await interaction.reply({
        content: 'У вас уже есть активная заявка. Дождитесь решения по ней.',
        ephemeral: true
      });
      return;
    }

    await interaction.showModal(applicationModal());
    return;
  }

  if (interaction.customId.startsWith('recruit:template-select:')) {
    await handleTemplateSelect(interaction);
    return;
  }

  if (interaction.customId.startsWith('recruit:templates:')) {
    await showTemplateMenu(interaction);
    return;
  }

  if (interaction.customId.startsWith('recruit:close-ticket:')) {
    await closeTicket(interaction);
    return;
  }

  if (!canReviewApplications(interaction.member)) {
    await interaction.reply({ content: 'Нет доступа к обработке заявок.', ephemeral: true });
    return;
  }

  const [, action, applicationId] = interaction.customId.split(':');
  const state = readState();
  const application = state.applications.find(item => item.id === applicationId);

  if (!application) {
    await interaction.reply({ content: 'Заявка не найдена.', ephemeral: true });
    return;
  }

  if (action === 'reject') {
    await interaction.showModal(rejectModal(application.id));
    return;
  }

  const nextStatus = {
    claim: 'review',
    call: 'call',
    accept: 'accepted'
  }[action];

  if (!nextStatus) {
    await interaction.reply({ content: 'Неизвестное действие.', ephemeral: true });
    return;
  }

  const updated = updateApplication(application.id, {
    status: nextStatus,
    reviewerId: interaction.user.id,
    reviewerTag: interaction.user.tag
  }, interaction.user);

  await syncCallChannelAccess(updated);
  await updateApplicationMessage(interaction, updated);
  await sendResultIfNeeded(interaction, updated);
  await sendApplicationDm(updated);
  await interaction.reply({
    content: statusReplyText(nextStatus, updated),
    ephemeral: true
  });
}

async function showTemplateMenu(interaction) {
  if (!canReviewApplications(interaction.member)) {
    await interaction.reply({ content: 'Нет доступа к шаблонам рекрутинга.', ephemeral: true });
    return;
  }

  const applicationId = interaction.customId.replace('recruit:templates:', '');
  const application = findApplicationInTicket(applicationId, interaction.channelId);

  if (!application) {
    await interaction.reply({ content: 'Шаблоны можно отправлять только в тикете заявки.', ephemeral: true });
    return;
  }

  await interaction.reply({
    content: 'Выберите готовый текст. Его увидит кандидат в этом тикете.',
    components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`recruit:template-select:${application.id}`)
        .setPlaceholder('Готовые ответы рекрута')
        .addOptions(...RECRUIT_TEMPLATES.map(template => ({
          label: template.label,
          value: template.value,
          description: template.description
        })))
    )],
    ephemeral: true
  });
}

async function handleTemplateSelect(interaction) {
  if (!canReviewApplications(interaction.member)) {
    await interaction.reply({ content: 'Нет доступа к шаблонам рекрутинга.', ephemeral: true });
    return;
  }

  const applicationId = interaction.customId.replace('recruit:template-select:', '');
  const application = findApplicationInTicket(applicationId, interaction.channelId);
  const template = RECRUIT_TEMPLATES.find(item => item.value === interaction.values?.[0]);

  if (!application || !template) {
    await interaction.update({ content: 'Шаблон или тикет не найден.', components: [] });
    return;
  }

  if (template.editable) {
    await interaction.showModal(templateAnswerModal(application.id));
    return;
  }

  await interaction.channel.send(recruitTemplateText(template, application, interaction.user));
  await interaction.update({ content: 'Текст отправлен в тикет.', components: [] });
}

async function handleTemplateAnswerModal(interaction) {
  if (!canReviewApplications(interaction.member)) {
    await interaction.reply({ content: 'Нет доступа к шаблонам рекрутинга.', ephemeral: true });
    return;
  }

  const applicationId = interaction.customId.replace('recruit:template-answer:', '');
  const application = findApplicationInTicket(applicationId, interaction.channelId);

  if (!application) {
    await interaction.reply({ content: 'Тикет заявки не найден.', ephemeral: true });
    return;
  }

  const point = fieldValue(interaction, 'templatePoint') || '[условно возвраст]';
  await interaction.channel.send(recruitTemplateText({
    text: () => [
      'В вашей заявке обнаружен некорректный, неполный либо отсутствует ответ в пункте: ' + point + '.',
      'Пожалуйста, исправьте его для дальнейшего рассмотрения.'
    ].join('\n')
  }, application, interaction.user));
  await interaction.reply({ content: 'Текст отправлен в тикет.', ephemeral: true });
}

function findApplicationInTicket(applicationId, channelId) {
  return readState().applications.find(item =>
    item.id === applicationId &&
    item.ticketChannelId === channelId
  );
}

function recruitTemplateText(template, application, actor) {
  return {
    content: `<@${application.userId}>`,
    allowedMentions: { users: [application.userId, actor.id], roles: [] },
    embeds: [new EmbedBuilder()
      .setDescription(template.text({ application, actor }))
      .setColor(0x2dd4bf)]
  };
}

async function handleModal(interaction) {
  if (interaction.customId === 'recruit:application-modal') {
    const previous = readState().applications.filter(item => item.userId === interaction.user.id);
    const application = {
      id: makeId('app'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'new',
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      username: interaction.user.username,
      answers: {
        profile: fieldValue(interaction, 'profile'),
        previousFamilies: fieldValue(interaction, 'previousFamilies'),
        hours: fieldValue(interaction, 'hours'),
        readiness: fieldValue(interaction, 'readiness')
      },
      reviewerId: '',
      reviewerTag: '',
      reason: '',
      messageId: '',
      channelId: '',
      ticketChannelId: ''
    };

    const saved = updateState(state => {
      state.applications.unshift(application);
      state.applications = state.applications.slice(0, 2000);
      addEvent(state, {
        type: 'application-created',
        applicationId: application.id,
        userId: interaction.user.id,
        userTag: interaction.user.tag
      });
      return application;
    });

    const ticketChannel = await createTicketChannel(interaction, saved, previous);
    if (ticketChannel) {
      saved.ticketChannelId = ticketChannel.id;
      updateState(state => {
        const item = state.applications.find(entry => entry.id === saved.id);
        if (item) {
          item.ticketChannelId = ticketChannel.id;
        }
      });
    }

    await publishApplication(saved, previous);
    await interaction.reply({
      content: ticketChannel
        ? `Заявка отправлена. Ваш тикет: <#${ticketChannel.id}>`
        : 'Заявка отправлена. Ожидайте решения от состава рекрутинга.',
      ephemeral: true
    });
    return;
  }

  if (interaction.customId.startsWith('recruit:template-answer:')) {
    await handleTemplateAnswerModal(interaction);
    return;
  }

  if (interaction.customId.startsWith('recruit:reject-modal:')) {
    if (!canReviewApplications(interaction.member)) {
      await interaction.reply({ content: 'Нет доступа к обработке заявок.', ephemeral: true });
      return;
    }

    const applicationId = interaction.customId.replace('recruit:reject-modal:', '');
    const reason = fieldValue(interaction, 'reason') || 'Причина не указана.';
    const updated = updateApplication(applicationId, {
      status: 'rejected',
      reviewerId: interaction.user.id,
      reviewerTag: interaction.user.tag,
      reason
    }, interaction.user);

    await syncCallChannelAccess(updated);
    await updateApplicationMessage(interaction, updated);
    await sendResultIfNeeded(interaction, updated);
    await sendApplicationDm(updated);
    await interaction.reply({
      content: 'Заявка отклонена, результат записан в логи.',
      ephemeral: true
    });
  }
}

async function closeTicket(interaction) {
  const applicationId = interaction.customId.replace('recruit:close-ticket:', '');
  const state = readState();
  const application = state.applications.find(item => item.id === applicationId);

  if (!application || application.ticketChannelId !== interaction.channelId) {
    await interaction.reply({
      content: 'Этот тикет не найден в базе бота.',
      ephemeral: true
    });
    return;
  }

  const canClose = interaction.user.id === application.userId || canReviewApplications(interaction.member);
  if (!canClose) {
    await interaction.reply({
      content: 'Закрыть этот тикет может кандидат или состав рекрутинга.',
      ephemeral: true
    });
    return;
  }

  updateState(state => {
    addEvent(state, {
      type: 'ticket-closed',
      applicationId: application.id,
      actorId: interaction.user.id,
      actorTag: interaction.user.tag,
      userId: application.userId,
      userTag: application.userTag
    });
  });

  await interaction.reply({
    content: 'Тикет закрыт. Канал будет удален автоматически через 10 секунд.'
  });

  setTimeout(async () => {
    try {
      const channel = await fetchChannel(interaction.channelId);
      if (channel) {
        await channel.delete(`Recruit ticket closed by ${interaction.user.tag}`);
      }
    } catch (error) {
      console.error('Failed to delete ticket channel.', error);
    }
  }, 10000);
}

async function publishApplication(application, previous) {
  const channel = await fetchChannel(LOG_CHANNEL_ID);
  if (!channel) {
    console.warn('APPLICATION_LOG_CHANNEL_ID is not set or channel not found.');
    return;
  }

  await channel.send({
    embeds: [applicationLogEmbed(application, previous)]
  });
}

async function createTicketChannel(interaction, application, previous) {
  const guild = interaction.guild || await fetchGuild();

  if (!guild) {
    console.warn('Guild not found, ticket channel was not created.');
    return null;
  }

  const channelName = ticketChannelName(application);
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionsBitField.Flags.ViewChannel]
    },
    {
      id: application.userId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory
      ]
    },
    ...[...new Set([...ADMIN_ROLE_IDS, ...RECRUITER_ROLE_IDS])].map(roleId => ({
      id: roleId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory
      ]
    }))
  ];

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID || undefined,
    topic: `Заявка ${application.id} | Discord ID: ${application.userId}`,
    permissionOverwrites: overwrites,
    reason: `Recruit application ticket for ${application.userTag}`
  });

  const message = await channel.send({
    content: ticketMentions(application),
    embeds: [applicationEmbed(application, previous)],
    components: applicationButtons(application)
  });

  updateState(state => {
    const item = state.applications.find(entry => entry.id === application.id);
    if (item) {
      item.messageId = message.id;
      item.channelId = message.channel.id;
      item.ticketChannelId = channel.id;
    }
  });

  application.messageId = message.id;
  application.channelId = message.channel.id;
  application.ticketChannelId = channel.id;

  return channel;
}

function updateApplication(id, patch, actor) {
  return updateState(state => {
    const application = state.applications.find(item => item.id === id);
    if (!application) {
      throw new Error('Application not found.');
    }

    Object.assign(application, patch, { updatedAt: new Date().toISOString() });
    addEvent(state, {
      type: `application-${application.status}`,
      applicationId: application.id,
      actorId: actor.id,
      actorTag: actor.tag,
      userId: application.userId,
      userTag: application.userTag,
      reason: application.reason || ''
    });
    return application;
  });
}

async function updateApplicationMessage(interaction, application) {
  const previous = readState().applications
    .filter(item => item.userId === application.userId && item.id !== application.id)
    .slice(0, 3);

  const message = interaction.message;
  if (!message?.editable) {
    return;
  }

  await message.edit({
    embeds: [applicationEmbed(application, previous)],
    components: terminalStatus(application.status) ? ticketCloseComponents(application) : applicationButtons(application)
  });
}

async function sendResultIfNeeded(interaction, application) {
  if (!['accepted', 'rejected'].includes(application.status)) {
    return;
  }

  const channel = await fetchChannel(RESULT_CHANNEL_ID);
  if (!channel) {
    return;
  }

  await channel.send({
    embeds: [resultEmbed(application)]
  });
}

async function sendApplicationDm(application) {
  if (!['review', 'call', 'accepted', 'rejected'].includes(application.status)) {
    return;
  }

  try {
    const user = await client.users.fetch(application.userId);
    await user.send({ embeds: [applicationDmEmbed(application)] });
  } catch (error) {
    console.warn(`Failed to send DM to ${application.userTag || application.userId}.`, error);
  }
}

async function syncCallChannelAccess(application) {
  if (!CALL_CHANNEL_ID) {
    return;
  }

  const channel = await fetchChannel(CALL_CHANNEL_ID);
  if (!channel) {
    console.warn(`CALL_CHANNEL_ID is set, but channel was not found: ${CALL_CHANNEL_ID}`);
    return;
  }

  try {
    if (application.status === 'call') {
      await channel.permissionOverwrites.edit(application.userId, {
        ViewChannel: true,
        Connect: true,
        Speak: true
      }, { reason: `Call access for ${application.userTag}` });
      return;
    }

    if (['accepted', 'rejected'].includes(application.status)) {
      await channel.permissionOverwrites.delete(application.userId, `Remove call access for ${application.userTag}`);
    }
  } catch (error) {
    console.error('Failed to sync call channel access.', error);
  }
}

function panelEmbeds(includeLocalFiles = true) {
  return [new EmbedBuilder()
    .setTitle('Заявки в семью REINHARD')
    .setDescription([
      '**Путь вместе с семьей начинается здесь.**',
      '',
      `**Обзвон**\nПриглашение обычно приходит в личные сообщения. Если ЛС закрыты, уведомление уйдет в канал ${resultChannelText()}. Там же появляются отказы в наборе.`,
      '',
      '**Ожидание**\nОбычно тикеты обрабатываются в течение **30-60 минут**. Время зависит от загрузки рекрутов.',
      '',
      '**Подача**\nТикет можно открыть только при активном наборе. Если форма не открывается — набор закрыт.'
    ].join('\n'))
    .setColor(0xf59e0b)];
}

function panelFiles() {
  return [];
}

function applicationModal() {
  return new ModalBuilder()
    .setCustomId('recruit:application-modal')
    .setTitle('Подать заявку')
    .addComponents(
      inputRow('profile', 'Ник в игре; возраст(OOC); имя (OOC)', TextInputStyle.Short, 'William Eyrinzez; 14; Иван'),
      inputRow('previousFamilies', 'В каких семьях был(-а), почему ушел', TextInputStyle.Paragraph, 'Если не был - так и напишите'),
      inputRow('hours', 'Сколько часов на GTA5RP', TextInputStyle.Short, '150+'),
      inputRow('readiness', 'Гос и Крайм: готов к этому?', TextInputStyle.Short, 'Да / Нет + короткий комментарий')
    );
}

function rejectModal(applicationId) {
  return new ModalBuilder()
    .setCustomId(`recruit:reject-modal:${applicationId}`)
    .setTitle('Отклонить заявку')
    .addComponents(
      inputRow('reason', 'Причина отказа', TextInputStyle.Paragraph, 'Например: набор временно закрыт')
    );
}

function templateAnswerModal(applicationId) {
  return new ModalBuilder()
    .setCustomId(`recruit:template-answer:${applicationId}`)
    .setTitle('Некорректный ответ')
    .addComponents(
      inputRow('templatePoint', 'Какой пункт нужно исправить?', TextInputStyle.Short, 'Например: возраст / опыт в семьях')
    );
}

function inputRow(customId, label, style, placeholder) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(style)
      .setPlaceholder(placeholder)
      .setRequired(true)
      .setMaxLength(style === TextInputStyle.Paragraph ? 900 : 120)
  );
}

function applicationEmbed(application, previous = []) {
  const status = statusMeta(application.status);
  const embed = new EmbedBuilder()
    .setTitle('Тикет')
    .setColor(status.color)
    .setDescription([
      `**${status.label}**`,
      `Кандидат: <@${application.userId}>`,
      application.reviewerId ? `Рекрутер: <@${application.reviewerId}>` : 'Рекрутер: не назначен',
      previous.length ? `История: ${previous.length} пред. заявк.` : 'История: заявок не найдено'
    ].join('\n'))
    .addFields(
      {
        name: 'Профиль',
        value: [
          `Username: **${application.username || '-'}**`,
          `Discord ID: \`${application.userId}\``,
          application.ticketChannelId ? `Тикет: <#${application.ticketChannelId}>` : ''
        ].filter(Boolean).join('\n'),
        inline: false
      },
      {
        name: 'Ваш ник в игре; возраст(OOC); имя (OOC)',
        value: crop(application.answers.profile, 350),
        inline: false
      },
      {
        name: 'В каких семьях был(-а) до этого; почему ушел',
        value: crop(application.answers.previousFamilies, 500),
        inline: false
      },
      {
        name: 'Сколько часов наиграно на GTA5RP?',
        value: crop(application.answers.hours, 180),
        inline: false
      },
      {
        name: 'Мы играем и Гос и Крайм, ты готов к этому?',
        value: crop(application.answers.readiness, 250),
        inline: false
      }
    )
    .setFooter({ text: formatDateTime(application.createdAt) });

  if (application.reason) {
    embed.addFields({ name: 'Причина решения', value: crop(application.reason), inline: false });
  }

  if (BRAND_ICON_URL) {
    embed.setThumbnail(BRAND_ICON_URL);
  }

  return embed;
}

function applicationLogEmbed(application, previous = []) {
  const status = statusMeta(application.status);

  return new EmbedBuilder()
    .setTitle('Новая заявка в семью')
    .setDescription([
      '**Создан приватный тикет для обработки кандидата.**',
      '',
      `• Кандидат: <@${application.userId}>`,
      `• Username: **${application.username || '-'}**`,
      application.ticketChannelId ? `• Тикет: <#${application.ticketChannelId}>` : '',
      previous.length ? `• История: ${previous.length} пред. заявк.` : '• История: заявок не найдено'
    ].filter(Boolean).join('\n'))
    .setColor(status.color)
    .setFooter({ text: `${FAMILY_NAME} 5RP • ${formatDateTime(application.createdAt)}` });
}

function resultEmbed(application) {
  const status = statusMeta(application.status);
  const data = {
    accepted: [
      `Заявка от пользователя <@${application.userId}>`,
      'На вступление в семью была одобрена. ✅',
      '',
      application.reviewerId ? `Рассматривал заявку: <@${application.reviewerId}>` : null
    ],
    rejected: [
      `Заявка от пользователя <@${application.userId}>`,
      'На вступление в семью была отклонена. ❌',
      '',
      `Причина: ${application.reason || 'не указана.'}`,
      application.reviewerId ? `Рассматривал заявку: <@${application.reviewerId}>` : null
    ]
  }[application.status] || [
    'Статус заявки обновлен.'
  ];

  return new EmbedBuilder()
    .setDescription(data.filter(line => line !== null && line !== undefined).join('\n'))
    .setColor(status.color);
}

function applicationDmEmbed(application) {
  const status = statusMeta(application.status);
  const data = {
    review: {
      title: 'Заявка на рассмотрении',
      lead: 'Ваша заявка взята в работу рекрутером.',
      body: 'Ожидайте дальнейшего ответа в личном тикете. Если потребуется уточнение, рекрутер напишет там.'
    },
    call: {
      title: 'Вызов на обзвон',
      lead: 'Ваша заявка предварительно одобрена.',
      body: CALL_CHANNEL_ID
        ? `Вам выдан доступ к voice-каналу: <#${CALL_CHANNEL_ID}>. Зайдите туда, когда будете готовы пройти обзвон.`
        : 'Ожидайте рекрутера в тикете: канал обзвона пока не указан.'
    },
    accepted: {
      title: 'Заявка одобрена',
      lead: 'Поздравляем, ваша заявка принята.',
      body: 'Ожидайте дальнейших действий от состава семьи.'
    },
    rejected: {
      title: 'Заявка отклонена',
      lead: 'По вашей заявке принято отрицательное решение.',
      body: `Причина: ${application.reason || 'не указана.'}`
    }
  }[application.status] || {
    title: 'Статус заявки',
    lead: 'Статус вашей заявки обновлен.',
    body: status.label
  };

  const embed = new EmbedBuilder()
    .setTitle(data.title)
    .setDescription([
      `**${data.lead}**`,
      '',
      data.body,
      '',
      `• Статус: **${status.label}**`,
      application.reviewerId ? `• Рекрутер: <@${application.reviewerId}>` : '',
      application.ticketChannelId ? `• Тикет: <#${application.ticketChannelId}>` : ''
    ].filter(Boolean).join('\n'))
    .setColor(status.color)
    .setFooter({ text: `${FAMILY_NAME} 5RP • ${formatDateTime(new Date().toISOString())}` });

  if (BRAND_ICON_URL) {
    embed.setThumbnail(BRAND_ICON_URL);
  }

  return embed;
}

function historyEmbed(user, items) {
  const embed = new EmbedBuilder()
    .setTitle(`${FAMILY_NAME} | История заявок`)
    .setColor(0x60a5fa)
    .setDescription(items.length ? `Последние заявки пользователя <@${user.id}>` : `Заявок пользователя <@${user.id}> не найдено.`);

  for (const item of items) {
    embed.addFields({
      name: `${statusMeta(item.status).label} | ${formatDateTime(item.createdAt)}`,
      value: [
        `Ник: ${crop(item.answers.profile, 120)}`,
        `Рекрутер: ${item.reviewerId ? `<@${item.reviewerId}>` : '-'}`,
        item.reason ? `Причина: ${crop(item.reason, 120)}` : ''
      ].filter(Boolean).join('\n'),
      inline: false
    });
  }

  return embed;
}

function applicationButtons(application) {
  const buttons = [
      new ButtonBuilder()
        .setCustomId(`recruit:accept:${application.id}`)
        .setLabel('Принять')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`recruit:claim:${application.id}`)
        .setLabel('Взять на рассмотрение')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`recruit:call:${application.id}`)
        .setLabel('Вызвать на обзвон')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`recruit:reject:${application.id}`)
        .setLabel('Отклонить')
        .setStyle(ButtonStyle.Danger)
  ];

  if (application.ticketChannelId) {
    buttons.push(closeTicketButton(application));
  }

  const rows = [new ActionRowBuilder().addComponents(...buttons)];
  if (application.ticketChannelId) {
    rows.push(templateButtonRow(application));
  }

  return rows;
}

function ticketCloseComponents(application) {
  return application.ticketChannelId
    ? [
      new ActionRowBuilder().addComponents(closeTicketButton(application)),
      templateButtonRow(application)
    ]
    : [];
}

function closeTicketButton(application) {
  return new ButtonBuilder()
    .setCustomId(`recruit:close-ticket:${application.id}`)
    .setLabel('Закрыть тикет')
    .setStyle(ButtonStyle.Secondary);
}

function templateButtonRow(application) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`recruit:templates:${application.id}`)
      .setLabel('Шаблоны')
      .setStyle(ButtonStyle.Secondary)
  );
}

function statusMeta(status) {
  return {
    new: { label: 'Ожидает рассмотрения', color: 0xf59e0b },
    review: { label: 'На рассмотрении', color: 0x5865f2 },
    call: { label: 'Вызван на обзвон', color: 0x5865f2 },
    accepted: { label: 'Принят', color: 0x10b981 },
    rejected: { label: 'Отклонен', color: 0xef4444 }
  }[status] || { label: status || 'Неизвестно', color: 0x94a3b8 };
}

function statusReplyText(status, application) {
  if (status === 'review') {
    return `Заявка взята на рассмотрение: <@${application.userId}>.`;
  }

  if (status === 'call') {
    return CALL_CHANNEL_ID
      ? `Кандидат вызван на обзвон: <@${application.userId}>. Доступ к <#${CALL_CHANNEL_ID}> выдан.`
      : `Кандидат вызван на обзвон: <@${application.userId}>. CALL_CHANNEL_ID не указан.`;
  }

  if (status === 'accepted') {
    return `Заявка принята: <@${application.userId}>.`;
  }

  return 'Статус обновлен.';
}

function terminalStatus(status) {
  return ['accepted', 'rejected'].includes(status);
}

function canManageRecruiting(member) {
  return hasAnyRole(member, ADMIN_ROLE_IDS) || member.permissions?.has(PermissionsBitField.Flags.ManageGuild);
}

function canReviewApplications(member) {
  return canManageRecruiting(member) || hasAnyRole(member, RECRUITER_ROLE_IDS);
}

function hasAnyRole(member, roleIds) {
  if (!roleIds.length) {
    return false;
  }

  return roleIds.some(roleId => member.roles?.cache?.has(roleId));
}

function recruiterMentions() {
  const ids = [...new Set([...ADMIN_ROLE_IDS, ...RECRUITER_ROLE_IDS])];
  return ids.length ? ids.map(id => `<@&${id}>`).join(' ') : '';
}

function ticketMentions(application) {
  return [
    `<@${application.userId}>`,
    recruiterMentions()
  ].filter(Boolean).join(' ');
}

function resultChannelText() {
  return RESULT_CHANNEL_ID ? `<#${RESULT_CHANNEL_ID}>` : 'канал итогов';
}

async function fetchChannel(id) {
  if (!id) {
    return null;
  }

  try {
    return await client.channels.fetch(id);
  } catch {
    return null;
  }
}

async function fetchGuild() {
  if (!GUILD_ID) {
    return client.guilds.cache.first() || null;
  }

  try {
    return await client.guilds.fetch(GUILD_ID);
  } catch {
    return null;
  }
}

function ticketChannelName(application) {
  const prefix = TICKET_NAME_PREFIX
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'ticket';
  const name = sanitizeChannelPart(application.username || application.userTag || application.userId);

  return `${prefix}-${name}`;
}

function discordChannelUrl(channelId) {
  const guildId = GUILD_ID || '@me';
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

function sanitizeChannelPart(value) {
  const clean = String(value || '')
    .toLowerCase()
    .replace(/#\d+$/, '')
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  return clean || 'user';
}

function countStatuses(applications) {
  return applications.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, { new: 0, review: 0, call: 0, accepted: 0, rejected: 0 });
}

function fieldValue(interaction, id) {
  return interaction.fields.getTextInputValue(id).trim();
}

function crop(text, limit = 900) {
  const value = String(text || '-').trim() || '-';
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function formatDateTime(input) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: process.env.TZ || 'Europe/Minsk'
    }).format(new Date(input));
  } catch {
    return input || '';
  }
}

function splitIds(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

async function safeReply(interaction, payload) {
  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

function startHttpApi() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);

    response.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Cache-Control', 'no-store');

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        ok: true,
        service: 'Reinhard Discord Bot',
        bot: client.user?.tag || 'starting'
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/applications') {
      const state = readState();
      sendJson(response, 200, {
        ok: true,
        settings: state.settings,
        applications: state.applications.slice(0, 500),
        events: state.events.slice(0, 200)
      });
      return;
    }

    sendJson(response, 404, { ok: false, error: 'Not found' });
  });

  server.listen(PORT, () => {
    console.log(`HTTP API listening on port ${PORT}`);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}
