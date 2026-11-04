import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client,Events,GatewayIntentBits,Partials,PermissionFlagsBits as P,PermissionsBitField,ChannelType,EmbedBuilder,ActionRowBuilder,ButtonBuilder,ButtonStyle,SlashCommandBuilder,MessageFlags} from 'discord.js';
import {normalise,isManagement,ticketStaff,validateRoleAssignment} from './policy.mjs';
const base=path.dirname(fileURLToPath(import.meta.url));
const cfg=JSON.parse(await fs.readFile(path.join(base,'config.json'),'utf8'));
if(!process.env.DISCORD_BOT_TOKEN){console.error('No bot token available. Run Start-Bot.ps1 and enter it privately.');process.exit(1)}
const fivemStatusUrl=(process.env.TWL_FIVEM_STATUS_URL||cfg.fivemUrl).replace(/\/+$/,'');
const membersEnabled=process.env.TWL_MEMBERS_INTENT!=='0';
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessageReactions,...(membersEnabled?[GatewayIntentBits.GuildMembers]:[])],partials:[Partials.Message,Partials.Reaction,Partials.User]});
let guild,roles,channels,timer,statusMessageId=null,statusBusy=false,setupStage='starting',starterRoles=[];
const ticketLocks=new Set();
const privateReply=(i,content)=>i.reply({content,flags:MessageFlags.Ephemeral});
const button=(id,label,style=ButtonStyle.Primary)=>new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style));
function findRole(label){const matches=guild.roles.cache.filter(r=>{const n=normalise(r.name);return n===label.toLowerCase()||n.startsWith(label.toLowerCase()+' —')});if(matches.size!==1)throw Error('Expected one role: '+label);return matches.first()}
function findChannel(label){const matches=guild.channels.cache.filter(c=>normalise(c.name)===normalise(label));if(matches.size!==1)throw Error('Expected one channel: '+label);return matches.first()}
const portalUrl=(cfg.portalUrl||'https://the-western-line-operations.rockycourt.chatgpt.site').replace(/\/+$/,'');
function welcomeMessage({memberId,username}={}){
 const rulesUrl=state.rulesMessageId?`https://discord.com/channels/${cfg.guildId}/${channels.rules.id}/${state.rulesMessageId}`:`https://discord.com/channels/${cfg.guildId}/${channels.rules.id}`;
 const name=String(username||'new member').replace(/([\\`*_~|>])/g,'\\$1').slice(0,100);
 const description=memberId?`Welcome, **${name}**!\n\nPlease see ${channels.rules} and react with ✅ to acknowledge the rules.`:`Welcome to The Western Line!\n\nPlease see ${channels.rules} and react with ✅ to acknowledge the rules.`;
 return {content:memberId?`Welcome to The Western Line, <@${memberId}>!`:'',embeds:[new EmbedBuilder().setTitle('Welcome to The Western Line').setDescription(description).setColor(0x183d5c).setThumbnail(portalUrl+'/server-logo.png').setImage(portalUrl+'/assets/server-banner.png').setFooter({text:'THE WESTERN LINE / YOUR LONDON JOURNEY STARTS HERE'})],components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Read & react to the rules').setEmoji('📋').setURL(rulesUrl),new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Community portal').setEmoji('🚇').setURL(portalUrl))],allowedMentions:{parse:[],users:memberId?[memberId]:[]}};
}
async function restoreOriginalPosts(){
 const posts=[
  {key:'welcomePanelId',channel:channels.welcome,original:'1566310454920224832',copy:'1566534736153677835'},
  {key:'ticketPanelId',channel:channels.support,original:'1566292671142563923',copy:'1566534737269362823'},
  {key:'statusMessageId',channel:channels.status,original:'1566292681586380841',copy:'1566534739563651184'}
 ];
 for(const post of posts){
  const original=await post.channel.messages.fetch(post.original).catch(()=>null);
  if(!original||original.author.id!==client.user.id)throw Error('Could not verify the original '+post.key+'; left messages untouched.');
  state[post.key]=original.id;
 }
 await saveState(state);
}
async function getState(){try{return JSON.parse(await fs.readFile(path.join(base,'data/state.json'),'utf8'))}catch(e){if(e.code==='ENOENT')return{};throw e}}
async function saveState(data){await fs.mkdir(path.join(base,'data'),{recursive:true});await fs.writeFile(path.join(base,'data/state.json.tmp'),JSON.stringify(data,null,2));await fs.rename(path.join(base,'data/state.json.tmp'),path.join(base,'data/state.json'))}
const state=await getState();
async function initialiseRulesReaction(){
 if(!channels?.rules)return;
 let post=null;
 if(state.rulesMessageId)post=await channels.rules.messages.fetch(state.rulesMessageId).catch(()=>null);
 if(!post){
  const recent=await channels.rules.messages.fetch({limit:100});
  post=recent.find(m=>{const text=[m.content,...m.embeds.flatMap(e=>[e.title,e.description])].filter(Boolean).join('\n').toLowerCase();return text.includes('rules')||text.includes('rule acknowledgement')})||null;
 }
 if(!post){console.warn('Rules verification reaction not activated: no rules post found in #'+channels.rules.name+'.');return}
 state.rulesMessageId=post.id;await saveState(state);
 await post.react('✅');
 console.log('Rules verification reaction is active on message '+post.id+'.');
}
async function updateStatus(){
 if(statusBusy||!channels?.status)return;statusBusy=true;
 try{
  let online=false,count=0,max=0;
  try{const [a,b]=await Promise.all([fetch(fivemStatusUrl+'/info.json',{signal:AbortSignal.timeout(5000)}),fetch(fivemStatusUrl+'/dynamic.json',{signal:AbortSignal.timeout(5000)})]);if(a.ok&&b.ok){const info=await a.json(),dynamic=await b.json();online=Boolean(info.vars);count=Number(dynamic.clients)||0;max=Number(dynamic.sv_maxclients)||0}}catch{}
  const stamp=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',dateStyle:'medium',timeStyle:'short'}).format(new Date());
  let message;if(state.statusMessageId)message=await channels.status.messages.fetch(state.statusMessageId).catch(()=>null);
  const currentBanner=message?.embeds?.[0]?.image?.url||state.statusBannerUrl;
  let keepBanner=false;
  try{if(currentBanner){const u=new URL(currentBanner),expiry=Number.parseInt(u.searchParams.get('ex')||'',16)*1000;keepBanner=u.pathname.endsWith('/server-status-banner.png')&&(!expiry||expiry>Date.now()+7200000)}}catch{}
  const banner=keepBanner?currentBanner:'attachment://server-status-banner.png';
  const embed=new EmbedBuilder().setTitle(cfg.serverName+' · FiveM status').setColor(online?0x38876b:0xc64b4b).setDescription(online?'🟢 Online':'🔴 Offline or restarting').addFields({name:'Players',value:online?count+' / '+(max||'?'):'—',inline:true},{name:'Operations',value:portalUrl,inline:true}).setImage(banner).setTimestamp();
  const bannerFile={attachment:path.join(base,'assets','server-status-banner.png'),name:'server-status-banner.png'};
  if(message?.author.id===client.user.id){
   const edit={embeds:[embed],allowedMentions:{parse:[]}};
   edit.attachments=[];if(!keepBanner)edit.files=[bannerFile];
   message=await message.edit(edit);
   const savedBanner=message.embeds?.[0]?.image?.url;if(savedBanner&&savedBanner!==state.statusBannerUrl){state.statusBannerUrl=savedBanner;await saveState(state)}
  }else{message=await channels.status.send({embeds:[embed],files:[bannerFile],allowedMentions:{parse:[]}});state.statusMessageId=message.id;state.statusBannerUrl=message.embeds?.[0]?.image?.url;await saveState(state)}
 }finally{statusBusy=false}
}
async function ticketPanel(){
 const data={embeds:[new EmbedBuilder().setTitle(cfg.serverName+' · Support').setColor(0x3498db).setDescription('Need help? Open a private ticket. Only you and Support, Moderators and senior staff can see it. Do not send passwords or payment information.')],components:[button('twl:open','🎫 Open a ticket')],allowedMentions:{parse:[]}};
 const old=state.ticketPanelId?await channels.support.messages.fetch(state.ticketPanelId).catch(()=>null):null;
 if(old?.author.id===client.user.id)return old;
 const m=await channels.support.send(data);state.ticketPanelId=m.id;await saveState(state);
}
async function openTicket(i){
 if(ticketLocks.has(i.user.id))return privateReply(i,'Your ticket is being created.');ticketLocks.add(i.user.id);
 try{
  await i.deferReply({flags:MessageFlags.Ephemeral});await guild.channels.fetch();
  const existing=guild.channels.cache.find(c=>c.type===ChannelType.GuildText&&c.topic==='twl-ticket:'+i.user.id);
  if(existing)return i.editReply('Your ticket is '+existing.toString());
  const staff=['owner','management','admin','moderator','support'].map(k=>roles[k]);
  const channel=await guild.channels.create({name:'ticket-'+i.user.id.slice(-6),type:ChannelType.GuildText,parent:channels.tickets.id,topic:'twl-ticket:'+i.user.id,permissionOverwrites:[{id:guild.id,deny:[P.ViewChannel]},{id:i.user.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.AttachFiles]},{id:client.user.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory,P.ManageChannels]},...staff.map(r=>({id:r.id,allow:[P.ViewChannel,P.SendMessages,P.ReadMessageHistory]}))],reason:'Member requested a support ticket'});
  await channel.send({content:`<@${i.user.id}> <@&${roles.support.id}> <@&${roles.moderator.id}>\nPlease describe the problem. Staff will respond here. Closing archives this channel; it does not delete the conversation.`,allowedMentions:{users:[i.user.id],roles:[roles.support.id,roles.moderator.id]},components:[button('twl:close','Close and archive ticket',ButtonStyle.Secondary)]});
  await i.editReply('Your private ticket is ready: '+channel.toString());
 }finally{ticketLocks.delete(i.user.id)}
}
async function closeTicket(i){
 if(!i.channel.topic?.startsWith('twl-ticket:'))return privateReply(i,'This is not a support ticket.');
 if(!ticketStaff(i.member,roles,guild.ownerId))return privateReply(i,'Support or moderation staff must close the ticket.');
 await i.deferReply({flags:MessageFlags.Ephemeral});const memberId=i.channel.topic.split(':')[1];
 await i.channel.permissionOverwrites.edit(memberId,{SendMessages:false,ViewChannel:true});
 await i.channel.setName('closed-'+i.channel.name.replace(/^ticket-/,'')).catch(()=>{});
 await i.channel.setTopic('twl-closed:'+memberId);
 await i.channel.send({content:'Ticket archived by '+i.user.toString()+'. The conversation is retained in this channel.',allowedMentions:{parse:[]},components:[]});
 await i.editReply('Ticket archived.');
}
async function setup(){
 setupStage='refresh guild inventory';
 await guild.roles.fetch();await guild.channels.fetch();
 setupStage='resolve configured roles';roles={};for(const [key,label]of Object.entries(cfg.roles)){
  try{roles[key]=findRole(label)}catch(e){if(key!=='support')throw e;roles.support=await guild.roles.create({name:'🎫 | Support',color:0xf1c40f,permissions:[],reason:'Requested support ticket team'})}
 }
 // The latest request puts the hammer on Moderator, retaining a star for Administrator.
 setupStage='apply staff role names';for(const [key,name]of [['admin','✦ | Administrator'],['moderator','🔨 | Moderator'],['developer','🔧 | Developer']]){if(roles[key].name!==name){if(roles[key].editable)await roles[key].setName(name,'Requested staff role symbols');else console.warn('Role order prevents editing '+roles[key].name+'; place the bot below Management and above Administrator.')}}
 setupStage='position Support role';
 await roles.support.setPosition(Math.max(1,roles.developer.position-1)).catch(()=>console.warn('Support role placement pending: move bot below Management and above Administrator.'));
 setupStage='resolve configured channels';
 channels={welcome:findChannel(cfg.channels.welcome),support:findChannel(cfg.channels.support),status:findChannel(cfg.channels.status),rules:findChannel(cfg.channels.rules||'rules')};
 await restoreOriginalPosts();
 setupStage='ensure ticket category';
 const existing=guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory&&c.name===cfg.channels.ticketCategory);
 channels.tickets=existing||await guild.channels.create({name:cfg.channels.ticketCategory,type:ChannelType.GuildCategory,permissionOverwrites:[{id:guild.id,deny:[P.ViewChannel]}]});
 for(const [key,allowed]of [['ownershipVoice',['owner']],['managementVoice',['owner','management']]]){
  setupStage='configure voice access: '+key;
  let voice=guild.channels.cache.find(c=>c.type===ChannelType.GuildVoice&&c.name===cfg.channels[key]);
  const overwrites=[{id:guild.id,deny:[P.ViewChannel,P.Connect]},...allowed.map(k=>({id:roles[k].id,allow:[P.ViewChannel,P.Connect,P.Speak]})),{id:client.user.id,allow:[P.ViewChannel,P.ManageChannels]}];
  if(voice)console.log('Keeping existing access rules for '+voice.name+'.');else await guild.channels.create({name:cfg.channels[key],type:ChannelType.GuildVoice,permissionOverwrites:overwrites});
 }
 setupStage='lock welcome channel';
 await channels.welcome.permissionOverwrites.set([{id:guild.id,allow:[P.ViewChannel],deny:[P.SendMessages,P.CreatePublicThreads,P.CreatePrivateThreads,P.SendMessagesInThreads]},...['owner','management'].map(k=>({id:roles[k].id,allow:[P.ViewChannel,P.SendMessages]})),{id:client.user.id,allow:[P.ViewChannel,P.SendMessages,P.EmbedLinks]}]);
 setupStage='limit role administration';
 const blocked=[];
 for(const r of guild.roles.cache.values()){
  if(r.managed||r.id===roles.owner.id||r.id===roles.management.id)continue;
  const cleaned=new PermissionsBitField(r.permissions.bitfield).remove(P.ManageRoles,P.Administrator);
  if(!cleaned.equals(r.permissions)){if(r.editable)await r.setPermissions(cleaned,'Only management and ownership may assign roles');else blocked.push(r.name)}
 }
 if(blocked.length)console.warn('Owner must remove Administrator / Manage Roles manually from: '+blocked.join(', '));
 if(!roles.management.permissions.has(P.ManageRoles))console.warn('The server owner must enable Manage Roles for Management. The bot cannot edit a higher role.');
  setupStage='update server branding';
 try{const icon=await fs.readFile(path.join(base,'assets/server-logo.png'));await guild.edit({name:cfg.serverName,icon,reason:'Requested The Western Line rebrand'})}catch(e){console.warn('Server name/logo update pending:',e.code||e.message)}
  setupStage='publish welcome panel';
 const content=welcomeMessage();
 const old=state.welcomePanelId?await channels.welcome.messages.fetch(state.welcomePanelId).catch(()=>null):null;
 const m=old?.author.id===client.user.id?await old.edit(content):await channels.welcome.send(content);state.welcomePanelId=m.id;await saveState(state);
  setupStage='publish ticket panel';await ticketPanel();
}
let guildInitialising=false,guildReady=false;
async function writeRuntime(extra={}){await fs.mkdir(path.join(base,'data'),{recursive:true});await fs.writeFile(path.join(base,'data/runtime.json'),JSON.stringify({pid:process.pid,online:client.isReady(),bot:client.user?.tag,guildId:cfg.guildId,guildJoined:client.guilds.cache.has(cfg.guildId),featuresReady:guildReady,membersIntent:membersEnabled,updated:new Date().toISOString(),...extra},null,2))}
const bridgeSecretPath=path.resolve(base,'..','txData','FiveMBasicServerCFXDefault_E575CC.base','twl_operations.secret.cfg');
let bridgeKey='',whitelistBridge;
async function startWhitelistBridge(){
 if(whitelistBridge?.listening)return;
 try{
  if(process.env.TWL_LOCAL_BRIDGE_KEY)bridgeKey=process.env.TWL_LOCAL_BRIDGE_KEY;
  else{
   const secretCfg=await fs.readFile(bridgeSecretPath,'utf8');
   const match=secretCfg.match(/^\s*set\s+twl_local_bridge_key\s+["']?([^"' \t\r\n]+)["']?\s*$/mi);
   if(!match)throw new Error('key_missing');
   bridgeKey=match[1];
  }
  if(!bridgeKey)throw new Error('key_missing');
 }catch(e){console.error('Whitelist bridge was not started: local server key is unavailable.',e.code||e.message);return}
 whitelistBridge=createServer((req,res)=>{void handleWhitelistBridge(req,res).catch(e=>{
  console.error('[Whitelist bridge] request failed:',e.code||e.name||'Error');
  if(!res.headersSent)sendBridgeJson(res,503,{error:'whitelist service unavailable'});else res.end();
 })});
 whitelistBridge.on('error',e=>console.error('Whitelist bridge listener failed:',e.code||e.name||'Error'));
 const hosted=Boolean(process.env.SERVER_PORT);
 const bridgePort=hosted?Number(process.env.SERVER_PORT):40210;
 const bridgeHost=hosted?'0.0.0.0':'127.0.0.1';
 if(!Number.isInteger(bridgePort)||bridgePort<1||bridgePort>65535)throw new Error('invalid_bridge_port');
 whitelistBridge.listen(bridgePort,bridgeHost,()=>console.log(`FiveM whitelist bridge active on ${bridgeHost}:${bridgePort}.`));
}
function sendBridgeJson(res,status,payload){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(payload))}
async function handleWhitelistBridge(req,res){
 if(req.method==='GET'&&req.url==='/health')return sendBridgeJson(res,200,{ok:true,discordReady:client.isReady(),guildReady});
 if(req.method!=='POST'||req.url!=='/fivem')return sendBridgeJson(res,404,{error:'not found'});
 const supplied=Buffer.from((req.headers.authorization||'').replace(/^Bearer\s+/i,''));
 const expected=Buffer.from(bridgeKey);
 if(!bridgeKey||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return sendBridgeJson(res,401,{error:'unauthorized'});
 let raw='',size=0;
 for await(const chunk of req){size+=chunk.length;if(size>8192)return sendBridgeJson(res,413,{error:'request too large'});raw+=chunk.toString('utf8')}
 let payload;try{payload=JSON.parse(raw||'{}')}catch{return sendBridgeJson(res,400,{error:'invalid JSON'})}
 if(payload.op!=='whitelist')return sendBridgeJson(res,400,{error:'unsupported operation'});
 if(!client.isReady()||!guildReady||!guild||!roles?.verified)return sendBridgeJson(res,503,{error:'Discord role data is not ready'});
 const discordId=String(payload.discordId||'');
 if(!/^\d{17,20}$/.test(discordId))return sendBridgeJson(res,200,{allowed:false,reason:'Connect your Discord account and join The Western Line Discord before joining FiveM.'});
 let member;
 try{member=await guild.members.fetch({user:discordId,force:true})}catch(e){if(e.code===10007||e.status===404)return sendBridgeJson(res,200,{allowed:false,reason:'Join The Western Line Discord to receive automatic member access, then reconnect.'});throw e}
 const whitelistRole=guild.roles.cache.find(r=>normalise(r.name)==='whitelisted');
 const accessRoles=[roles.verified,whitelistRole,roles.owner,roles.management,roles.admin,roles.moderator,roles.developer].filter(Boolean);
 const allowed=discordId===guild.ownerId||accessRoles.some(role=>member.roles.cache.has(role.id));
 return sendBridgeJson(res,200,{allowed,reason:allowed?undefined:'A Verified Member or Whitelisted Discord role is required to join The Western Line.'});
}
async function initialiseGuild(){
 if(guildInitialising||guildReady)return;guildInitialising=true;
 try{
   setupStage='check configured guild membership';
  if(!client.guilds.cache.has(cfg.guildId)){console.log('Bot connected to Discord and online. Waiting for its invitation to the configured server.');await writeRuntime();return}
   setupStage='fetch guild roles and channels';
  guild=await client.guilds.fetch(cfg.guildId);await guild.roles.fetch();await guild.channels.fetch();
   if(process.argv.includes('--configure')){setupStage='configure server resources';await setup()}
  else{roles=Object.fromEntries(Object.entries(cfg.roles).map(([k,label])=>[k,findRole(label)]));starterRoles=[];for(const label of (Array.isArray(cfg.joinRoles)?cfg.joinRoles:[])){const matches=guild.roles.cache.filter(r=>normalise(r.name)===normalise(label));if(matches.size===1)starterRoles.push(matches.first());else console.warn('Starter role missing or duplicated; skipped automatic assignment:',label)}channels={welcome:findChannel(cfg.channels.welcome),support:findChannel(cfg.channels.support),status:findChannel(cfg.channels.status),rules:findChannel(cfg.channels.rules||'rules'),tickets:guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory&&c.name===cfg.channels.ticketCategory)};if(!channels.tickets)throw Error('Run Start-Bot.ps1 -Configure once to create the ticket category and channels.');setupStage='restore original welcome, support and status posts';await restoreOriginalPosts()}
    setupStage='activate rules verification reaction';await initialiseRulesReaction();
    setupStage='register slash commands';
  await guild.commands.set([new SlashCommandBuilder().setName('ticket').setDescription('Open your private support ticket'),new SlashCommandBuilder().setName('ticketpanel').setDescription('Management: post or refresh the support panel'),new SlashCommandBuilder().setName('role').setDescription('Management: assign or remove a role').addUserOption(o=>o.setName('member').setDescription('Member').setRequired(true)).addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true)).addBooleanOption(o=>o.setName('remove').setDescription('Remove instead of adding'))].map(c=>c.toJSON()));
   setupStage='update server status';await updateStatus();timer=setInterval(()=>updateStatus().catch(e=>console.error('Status update failed:',e.message)),Math.max(30,cfg.statusIntervalSeconds)*1000);
  console.log('The Western Line bot is ready. Tickets, welcome, verified role and server status are running.');
   guildReady=true;setupStage='ready';await writeRuntime();
  }catch(e){const issue=setupStage+': '+(e.code||e.message);console.error('Server features need attention:',issue,{status:e.status,method:e.method,route:e.url});await writeRuntime({problem:issue})}
 finally{guildInitialising=false}
}
client.once(Events.ClientReady,async()=>{client.user.setPresence({status:'online',activities:[{name:'The Western Line support'}]});console.log('Connected to Discord as '+client.user.tag+' on this PC.');await initialiseGuild();await startWhitelistBridge()});
client.on(Events.GuildCreate,async g=>{if(g.id===cfg.guildId)await initialiseGuild()});
setInterval(()=>{if(client.isReady()){writeRuntime().catch(()=>{});if(!guildReady)initialiseGuild().catch(()=>{})}},60000);
client.on(Events.GuildMemberAdd,async member=>{
 if(member.guild.id!==cfg.guildId||member.user.bot||!roles)return;
 const desired=[roles.verified,...starterRoles].filter(Boolean);
 const missing=desired.filter(role=>!member.roles.cache.has(role.id));
 const editable=missing.filter(role=>role.editable);
 try{if(editable.length)await member.roles.add(editable,'Automatic newcomer access and service starter roles');if(editable.length!==missing.length)console.error('Some starter roles could not be assigned; move the bot role above them:',missing.filter(r=>!r.editable).map(r=>r.name).join(', '))}catch(e){console.error('New member role assignment failed:',e.message)}
 try{await channels.welcome.send(welcomeMessage({memberId:member.id,username:member.user.username}))}catch(e){console.error('Personalised join welcome failed:',e.message)}
});
async function handleRulesReaction(reaction,user,added){
 if(user.bot||!guildReady||!guild||!channels?.rules||!roles?.verified)return;
 try{
  if(reaction.partial)reaction=await reaction.fetch();
  const message=reaction.message;
  if(message.guildId!==cfg.guildId||message.channelId!==channels.rules.id||message.id!==state.rulesMessageId||reaction.emoji.name!=='✅')return;
  const member=await guild.members.fetch(user.id);
  if(!roles.verified.editable)throw Error('Place the bot role above the Verified role.');
  if(added)await member.roles.add(roles.verified,'Reacted to the rules');
  else await member.roles.remove(roles.verified,'Removed the rules verification reaction');
 }catch(e){console.error('Rules verification role update failed:',e.code||e.message)}
}
client.on(Events.MessageReactionAdd,(reaction,user)=>handleRulesReaction(reaction,user,true));
client.on(Events.MessageReactionRemove,(reaction,user)=>handleRulesReaction(reaction,user,false));
client.on(Events.InteractionCreate,async i=>{
 if(i.guildId!==cfg.guildId||!roles)return;
 try{
  if(i.isButton()){if(i.customId==='twl:open')return await openTicket(i);if(i.customId==='twl:close')return await closeTicket(i);return}
  if(!i.isChatInputCommand())return;
  if(i.commandName==='ticket')return await openTicket(i);
  if(i.commandName==='ticketpanel'){if(!isManagement(i.member,roles,guild.ownerId))return privateReply(i,'Management or ownership only.');await i.deferReply({flags:MessageFlags.Ephemeral});await ticketPanel();return i.editReply('Support panel updated.')}
  if(i.commandName==='role'){
   const target=await guild.members.fetch(i.options.getUser('member',true).id);const role=i.options.getRole('role',true);
   const problem=validateRoleAssignment(i.member,target,role,roles,guild.ownerId);if(problem)return privateReply(i,problem);
   if(!role.editable)return privateReply(i,'The bot role must be above that role.');
   await i.deferReply({flags:MessageFlags.Ephemeral});if(i.options.getBoolean('remove'))await target.roles.remove(role,'Management role command');else await target.roles.add(role,'Management role command');return i.editReply('Role updated for '+target.toString());
  }
 }catch(e){const reply={content:'That action could not complete: '+e.message,flags:MessageFlags.Ephemeral};if(i.deferred||i.replied)await i.editReply({content:reply.content}).catch(()=>{});else await i.reply(reply).catch(()=>{});console.error('Interaction failed:',e.code||e.name)}
});
client.on(Events.Error,e=>console.error('Discord connection error:',e.code||e.name));
client.on(Events.ShardDisconnect,event=>{if(event.code===4014){console.error('Server Members Intent is disabled in the Developer Portal. Switching to online ticket/status mode; auto-welcome and auto-Verified await that intent.');process.exit(14)}});
const shutdown=()=>{clearInterval(timer);client.destroy();process.exit(0)};process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
await client.login(process.env.DISCORD_BOT_TOKEN).catch(()=>{console.error('Bot login failed. Check the token and Server Members Intent in the Developer Portal.');process.exitCode=1});
