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

client.once('ready', async () => {
  console.log(`ReinhardBot logged in as ${client.user.tag}`);
  await registerCommands();
  startHttpApi();
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

client.login(TOKEN);

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
          .setPlaceholder('Здесь Вы можете подать заявку')
          .addOptions({
            label: 'Подать заявку',
            value: 'apply',
            description: 'Открыть форму вступления в семью'
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

  await updateApplicationMessage(interaction, updated);
  await sendResultIfNeeded(interaction, updated);
  await interaction.reply({
    content: statusReplyText(nextStatus, updated),
    ephemeral: true
  });
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

    await updateApplicationMessage(interaction, updated);
    await sendResultIfNeeded(interaction, updated);
    await interaction.reply({
      content: 'Заявка отклонена, результат записан в логи.',
      ephemeral: true
    });
  }
}

async function publishApplication(application, previous) {
  const channel = await fetchChannel(LOG_CHANNEL_ID);
  if (!channel) {
    console.warn('APPLICATION_LOG_CHANNEL_ID is not set or channel not found.');
    return;
  }

  const message = await channel.send({
    content: recruiterMentions(),
    embeds: [applicationEmbed(application, previous)],
    components: applicationButtons(application)
  });

  updateState(state => {
    const item = state.applications.find(entry => entry.id === application.id);
    if (item) {
      item.messageId = message.id;
      item.channelId = message.channel.id;
    }
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

  await channel.send({
    content: [
      `<@${application.userId}>`,
      recruiterMentions(),
      '',
      'Приветствую. Ваша заявка создана, ожидайте ответа рекрутера в этом канале.'
    ].filter(Boolean).join('\n'),
    embeds: [applicationEmbed(application, previous)],
    components: applicationButtons(application)
  });

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
    components: terminalStatus(application.status) ? [] : applicationButtons(application)
  });
}

async function sendResultIfNeeded(interaction, application) {
  if (!['call', 'accepted', 'rejected'].includes(application.status)) {
    return;
  }

  const channel = await fetchChannel(RESULT_CHANNEL_ID);
  if (!channel) {
    return;
  }

  await channel.send({
    content: `<@${application.userId}>`,
    embeds: [resultEmbed(application)]
  });
}

function panelEmbeds(includeLocalFiles = true) {
  const embeds = [];
  const imageEmbed = new EmbedBuilder().setColor(0xf59e0b);

  if (PANEL_IMAGE_URL) {
    imageEmbed.setImage(PANEL_IMAGE_URL);
    embeds.push(imageEmbed);
  } else if (includeLocalFiles && fs.existsSync(LOCAL_PANEL_IMAGE)) {
    imageEmbed.setImage(`attachment://${PANEL_ATTACHMENT_NAME}`);
    embeds.push(imageEmbed);
  }

  const infoEmbed = new EmbedBuilder()
    .setTitle('👋 Путь в семью начинается здесь!')
    .setDescription([
      `• Уведомление о приглашении на обзвон обычно отправляется в личные сообщения. Если ЛС закрыты, оно отправляется в канал — ${resultChannelText()}. В этот канал также приходят уведомления об отказе в наборе.`,
      '',
      'Обычно заявки обрабатываются в течение 3–7 дней — всё зависит от того, насколько загружены наши рекрутеры на данный момент.',
      '',
      'Подать заявку можно только при открытом наборе. Если не выходит — набор закрыт. Внимательно прочтите сообщение ниже.',
      '',
      'Не указывайте пароли, токены и другую конфиденциальную информацию.'
    ].join('\n'))
    .setColor(0xf59e0b);

  if (BRAND_ICON_URL) {
    infoEmbed.setFooter({ text: `${FAMILY_NAME} 5RP`, iconURL: BRAND_ICON_URL });
  } else if (includeLocalFiles && fs.existsSync(LOCAL_BRAND_ICON)) {
    infoEmbed.setFooter({ text: `${FAMILY_NAME} 5RP`, iconURL: `attachment://${BRAND_ATTACHMENT_NAME}` });
  } else {
    infoEmbed.setFooter({ text: `${FAMILY_NAME} 5RP` });
  }

  embeds.push(infoEmbed);
  return embeds;
}

function panelFiles() {
  if (PANEL_IMAGE_URL && BRAND_ICON_URL) {
    return [];
  }

  const files = [];

  if (!PANEL_IMAGE_URL) {
    if (fs.existsSync(LOCAL_PANEL_IMAGE)) {
      files.push(new AttachmentBuilder(LOCAL_PANEL_IMAGE, { name: PANEL_ATTACHMENT_NAME }));
    } else {
      console.warn(`Panel image not found: ${LOCAL_PANEL_IMAGE}`);
    }
  }

  if (!BRAND_ICON_URL) {
    if (fs.existsSync(LOCAL_BRAND_ICON)) {
      files.push(new AttachmentBuilder(LOCAL_BRAND_ICON, { name: BRAND_ATTACHMENT_NAME }));
    } else {
      console.warn(`Brand icon not found: ${LOCAL_BRAND_ICON}`);
    }
  }

  return files;
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
    .setTitle(`${FAMILY_NAME} | Заявление`)
    .setColor(status.color)
    .setDescription(previous.length ? `Предыдущие заявки: ${previous.length}` : 'Предыдущие заявки: не найдено')
    .addFields(
      { name: 'Ник в игре; возраст(OOC); имя (OOC)', value: crop(application.answers.profile), inline: false },
      { name: 'В каких семьях был(-а), почему ушел', value: crop(application.answers.previousFamilies), inline: false },
      { name: 'Сколько часов на GTA5RP', value: crop(application.answers.hours), inline: false },
      { name: 'Гос и Крайм', value: crop(application.answers.readiness), inline: false },
      { name: 'Пользователь', value: `<@${application.userId}>`, inline: true },
      { name: 'Username', value: application.username || '-', inline: true },
      { name: 'ID', value: application.userId, inline: true },
      { name: 'Статус', value: status.label, inline: true },
      { name: 'Рекрутер', value: application.reviewerId ? `<@${application.reviewerId}>` : 'Не назначен', inline: true },
      { name: 'Тикет', value: application.ticketChannelId ? `<#${application.ticketChannelId}>` : 'Не создан', inline: true }
    )
    .setFooter({ text: formatDateTime(application.createdAt) });

  if (application.reason) {
    embed.addFields({ name: 'Причина', value: crop(application.reason), inline: false });
  }

  if (BRAND_ICON_URL) {
    embed.setThumbnail(BRAND_ICON_URL);
  }

  return embed;
}

function resultEmbed(application) {
  const status = statusMeta(application.status);
  const lines = {
    call: [
      'Ваша заявка рассмотрена и предварительно одобрена.',
      CALL_CHANNEL_ID ? `Для прохождения обзвона ожидаем вас в канале: <#${CALL_CHANNEL_ID}>` : 'Ожидайте указаний по обзвону.'
    ],
    accepted: [
      `Ваша заявка на вступление в ${FAMILY_NAME} была одобрена.`,
      'Ожидайте дальнейших действий от состава семьи.'
    ],
    rejected: [
      `Ваша заявка на вступление в ${FAMILY_NAME} была отклонена.`,
      `Причина: ${application.reason || 'не указана.'}`
    ]
  }[application.status] || ['Статус заявки обновлен.'];

  return new EmbedBuilder()
    .setTitle(`${FAMILY_NAME} | Результат заявки`)
    .setDescription(lines.join('\n'))
    .setColor(status.color)
    .addFields(
      { name: 'Кандидат', value: `<@${application.userId}>`, inline: true },
      { name: 'Рассматривал', value: application.reviewerId ? `<@${application.reviewerId}>` : '-', inline: true }
    )
    .setTimestamp(new Date());
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
    buttons.push(
      new ButtonBuilder()
        .setLabel('Открыть тикет')
        .setStyle(ButtonStyle.Link)
        .setURL(discordChannelUrl(application.ticketChannelId))
    );
  }

  return [new ActionRowBuilder().addComponents(...buttons)];
}

function statusMeta(status) {
  return {
    new: { label: 'Ожидает рассмотрения', color: 0xf59e0b },
    review: { label: 'На рассмотрении', color: 0x6366f1 },
    call: { label: 'Вызван на обзвон', color: 0x22c55e },
    accepted: { label: 'Принят', color: 0x10b981 },
    rejected: { label: 'Отклонен', color: 0xef4444 }
  }[status] || { label: status || 'Неизвестно', color: 0x94a3b8 };
}

function statusReplyText(status, application) {
  if (status === 'review') {
    return `Заявка взята на рассмотрение: <@${application.userId}>.`;
  }

  if (status === 'call') {
    return `Кандидат вызван на обзвон: <@${application.userId}>.`;
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
