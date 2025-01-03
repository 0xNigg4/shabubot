require('dotenv').config();

const { 
  Client, 
  GatewayIntentBits, 
  ApplicationCommandType, 
  ApplicationCommandOptionType, 
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType
} = require('discord.js');
const mysql = require('mysql2/promise');
const { createCanvas, loadImage } = require('canvas');
const QRCode = require('qrcode');

const SF_ROLE_ID = '1303016685699203122';
const ESIM_CHANNEL_ID = '1324351256709431336';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

let db;

async function connectToDatabase() {
  try {
    db = await mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      ssl: {
        rejectUnauthorized: false,
      },
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
    console.log('Successfully connected to the database.');
  } catch (error) {
    console.error('Failed to connect to the database:', error);
    process.exit(1);
  }
}

async function checkPendingOrdersAndCreateTicket(member, customerEmail) {
  try {
    const [orders] = await db.execute(
      'SELECT * FROM orders WHERE customer_email = ? AND status = ?',
      [customerEmail, 'pending']
    );

    if (orders.length > 0) {
      const order = orders[0];
      const ticketChannelName = `ticket-${order.id}`;

      const existingTicket = member.guild.channels.cache.find(
        channel => channel.name === ticketChannelName
      );

      if (!existingTicket) {
        const [products] = await db.execute(
          'SELECT * FROM products WHERE id = ?',
          [order.product_id]
        );

        if (products.length === 0) {
          console.error(`Product with ID ${order.product_id} not found.`);
          return;
        }

        const product = products[0];

        const ticketChannel = await member.guild.channels.create({
          name: ticketChannelName,
          type: ChannelType.GuildText,
          permissionOverwrites: [
            {
              id: member.guild.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: member.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
            {
              id: client.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ],
        });

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('ticket_completed')
              .setLabel('Completed')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('ticket_failed')
              .setLabel('Failed')
              .setStyle(ButtonStyle.Danger)
          );

        await ticketChannel.send({
          content: `Welcome ${member}! This is your ticket for Order #${order.id}.\n\n`
            + `Order Details:\n`
            + `- Order ID: ${order.id}\n`
            + `- Product ID: ${order.product_id}\n`
            + `- Product Name: ${product.name}\n`
            + `- Status: ${order.status}\n`
            + `- Created: ${new Date(order.created_at).toLocaleString()}\n\n`
            + `A staff member will assist you shortly.`,
          components: [row]
        });

        console.log(`Created ticket channel ${ticketChannelName} for user ${member.user.tag}`);
      }
    }
  } catch (error) {
    console.error('Error checking pending orders:', error);
  }
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  try {
    await client.application.commands.create({
      name: 'verify',
      description: 'Verify your account with the unique code from your email',
      type: ApplicationCommandType.ChatInput,
      options: [
        {
          name: 'code',
          description: 'Your unique verification code',
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    });
    console.log('Verify command registered successfully');

    await client.application.commands.create({
      name: 'esim',
      description: 'Generate an eSIM QR code (SF role required)',
      type: ApplicationCommandType.ChatInput,
      defaultMemberPermissions: PermissionFlagsBits.UseApplicationCommands,
    });
    console.log('eSIM command registered successfully');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'esim') {
        // Defer reply if this command takes time
        if (interaction.channelId !== ESIM_CHANNEL_ID) {
          await interaction.reply({ 
            content: 'This command can only be used in the designated eSIM generator channel.', 
            flags: 64 
          });
          return;
        }

        if (!interaction.member?.roles.cache.has(SF_ROLE_ID)) {
          await interaction.reply({ 
            content: 'You do not have permission to use this command.', 
            flags: 64 
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId('esim_details')
          .setTitle('Enter eSIM Details');

        // Create the two input fields
        const activationCodeInput = new TextInputBuilder()
          .setCustomId('activationCode')
          .setLabel('Enter the eSIM activation code')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter the activation code here')
          .setRequired(true);

        const smdpAddressInput = new TextInputBuilder()
          .setCustomId('smdpAddress')
          .setLabel('Enter the SM-DP+ address')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter the SM-DP+ address here')
          .setRequired(true);

        // Add them to the modal in action rows
        const actionRow1 = new ActionRowBuilder().addComponents(activationCodeInput);
        const actionRow2 = new ActionRowBuilder().addComponents(smdpAddressInput);

        modal.addComponents(actionRow1, actionRow2);

        await interaction.showModal(modal);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'esim_details') {
        const activationCode = interaction.fields.getTextInputValue('activationCode');
        const smdpAddress = interaction.fields.getTextInputValue('smdpAddress');

        client.activationCodes = client.activationCodes || new Map();
        client.activationCodes.set(interaction.user.id, activationCode);

        // Now proceed to generate the QR code with both values
        try {
          const qrCodeBuffer = await generateQRCode(activationCode, smdpAddress);
          const attachment = new AttachmentBuilder(qrCodeBuffer, { name: 'esim_qr_code.png' });

          await interaction.reply({
            content: 'Here is your eSIM QR code:',
            files: [attachment]
          });
        } catch (error) {
          console.error('Error generating QR code:', error);
          await interaction.reply('An error occurred while generating the QR code. Please try again.');
        }
      }
    }
  } catch (error) {
    console.error('Error in interaction handler:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ 
          content: 'An error occurred while processing your request. Please try again.',
          flags: 64 
        });
      } else {
        await interaction.editReply({
          content: 'An error occurred while processing your request. Please try again.'
        });
      }
    } catch (replyError) {
      console.error('Error sending error message:', replyError);
    }
  }
});


client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.channel.name === 'verify') {
    try {
      await message.delete();
      await message.channel.send({
        content: `Welcome to SF ${message.author}, please use the /verify command with your unique code to verify your account.`,
        flags: 64
      });
    } catch (error) {
      console.error('Error handling verify channel message:', error);
    }
    return;
  }

  if (message.channel.name === 'welcome') {
    try {
      await message.delete();
      await message.channel.send({
        content: `${message.author}, please use the /verify command in <#${message.guild.channels.cache.find(ch => ch.name === 'verify')?.id}> with your unique code to verify your account.`,
        flags: 64
      });
    } catch (error) {
      console.error('Error handling welcome channel message:', error);
    }
    return;
  }
});

async function generateQRCode(activationCode, smDpAddress) {
  const qrData = `1$esim$${smDpAddress}$${activationCode}`;
  const canvas = createCanvas(300, 300);
  const ctx = canvas.getContext('2d');

  await QRCode.toCanvas(canvas, qrData, {
    errorCorrectionLevel: 'H',
    margin: 4,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
  });

  return canvas.toBuffer('image/png');
}

async function startBot() {
  await connectToDatabase();
  try {
    await client.login(process.env.DISCORD_BOT_TOKEN);
    console.log('Bot is now running.');
  } catch (error) {
    console.error('Failed to start the bot:', error);
    process.exit(1);
  }
}

startBot();