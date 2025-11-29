// websocket_test.js
// Node.js WebSocket server for Narwhale v4.992 (preserves original CONFIG + OPCODES).
// Usage: PORT=3000 node websocket_test.js
// Requires: npm i ws

const WebSocket = require('ws');

// ==================== CONFIGURACIÓN (kept as requested) ====================
const CONFIG = {
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000, // allow override
  tickRate: 60,
  worldWidth: 6400,
  worldHeight: 6400,
  maxPlayersPerRoom: 50,
  // Seguridad
  maxInputRate: 120, // inputs per second
  maxVelocity: 500,
  maxDashCooldown: 1.0,
  teleportThreshold: 1000, // detection
  // Física
  friction: 0.95,
  acceleration: 200,
  dashPower: 300,
  collisionDamage: 100,
};

// ==================== OPCODES (unchanged) ====================
const OPCODES = {
  // Cliente → Servidor
  JOIN: 16,
  LEAVE: 17,
  START: 18,
  GET_LOBBIES: 19,
  UPDATE_TARGET: 32,
  SPLIT_UP: 33,
  RIP: 34,
  RETREAT: 35,
  PLAYER_UPDATE: 36,
  PING: 37,
  INPUT: 38,
  // Servidor → Cliente
  SET_ELEMENTS: 48,
  PLAYER_INFO: 49,
  LEADER_BOARD: 50,
  TEAM_INFO: 51,
  TRANSIENT_ELEMENT: 52,
};

// ==================== ELEMENT TYPES (unchanged) ====================
const ELEMENT_TYPES = {
  FISH: 0,
  BALL: 1,
  ATTACHABLE: 2,
  CHARACTER: 3,
  BOMB: 4,
  OCCUPIABLE: 5,
  FOOD: 6,
};

// ----------------- Small utilities -----------------
class Vec2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  length() { return Math.sqrt(this.x*this.x + this.y*this.y); }
  normalize() { const l = this.length(); if (l>0){this.x/=l; this.y/=l;} return this; }
  clone() { return new Vec2(this.x, this.y); }
  distance(o) { const dx=this.x-o.x, dy=this.y-o.y; return Math.sqrt(dx*dx+dy*dy); }
}

// ----------------- Input validator (unchanged behavior) -----------------
class InputValidator {
  constructor() { this.playerInputs = new Map(); }
  validateInputRate(playerId) {
    const now = Date.now();
    if (!this.playerInputs.has(playerId)) this.playerInputs.set(playerId, {count:0,lastReset:now});
    const d = this.playerInputs.get(playerId);
    if (now - d.lastReset > 1000) { d.count = 0; d.lastReset = now; }
    d.count++;
    return d.count <= CONFIG.maxInputRate;
  }
  validateDash(player) {
    const now = Date.now();
    if (player.curDash <= 0) return false;
    if (player.lastDashTime && (now - player.lastDashTime) < 100) return false;
    return true;
  }
  validatePosition(oldPos, newPos, deltaTime) {
    const maxDistance = CONFIG.maxVelocity * deltaTime;
    const actualDistance = oldPos.distance(newPos);
    if (actualDistance > maxDistance * 2) return false;
    return true;
  }
}

// ----------------- Narwhale part + Player classes (kept logic, small safety tweaks) -----------------
class NarwhalePart {
  constructor(){ this.x=0; this.y=0; this.vx=0; this.vy=0; this.rot=0; this.vt=0; this.oriRot=0; }
  update(dt){ this.x += this.vx*dt; this.y += this.vy*dt; this.rot += this.vt*dt; }
  dampVelocity(factor, dt){ this.vx *= Math.pow(factor, dt*60); this.vy *= Math.pow(factor, dt*60); }
}

class Player {
  constructor(id, socket=null, name='Narwhal') {
    this.id = id;
    this.socket = socket;
    this.name = (name||'Narwhal').substring(0,16);
    this.uid = id;
    this.color = this.randomColor();
    this.team = Math.random()>0.5 ? 1 : -1;
    this.size = 36; this.alpha = 1.0; this.level = 1; this.score = 0; this.kills = 0; this.deaths = 0;
    this.pos = new Vec2(CONFIG.worldWidth/2, CONFIG.worldHeight/2);
    this.vel = new Vec2(0,0);
    this.angle = Math.random()*Math.PI*2;
    this.speed = 0; this.maxSpeed = 150;
    this.parts = []; this.breakPoint = 11; this.initializeParts();
    this.maxDash = 5; this.curDash = 5; this.overDash = 0; this.dashRegenRate = 0.6;
    this.tuskRatio = 0.5; this.decoration = 0; this.invincibleDur = 0;
    this.skincode = Math.floor(Math.random()*18);
    this.isAlive = true; this.isSpawned = false; this.respawnTime = 0; this.currentRoom = null;
    this.targetX = 0.001; this.targetY = 0; this.inputFlags = 0;
    this.lastPosition = this.pos.clone(); this.lastDashTime = 0; this.inputSequence = 0; this.lastInputTime = Date.now();
  }

  initializeParts(){ for(let i=0;i<11;i++){ const p=new NarwhalePart(); p.x=this.pos.x - i*20; p.y=this.pos.y; p.rot=this.angle; this.parts.push(p);} }
  randomColor(){ const h=Math.random(), s=0.9, l=0.635; return this.hslToRgb(h,s,l); }
  hslToRgb(h,s,l){ let r,g,b; if(s===0){r=g=b=l;} else { const hue2rgb=(p,q,t)=>{if(t<0)t+=1; if(t>1)t-=1; if(t<1/6) return p+(q-p)*6*t; if(t<1/2) return q; if(t<2/3) return p+(q-p)*(2/3-t)*6; return p;}; const q=l<0.5?l*(1+s):l+s-l*s; const p=2*l-q; r=hue2rgb(p,q,h+1/3); g=hue2rgb(p,q,h); b=hue2rgb(p,q,h-1/3);} return (Math.round(r*255)<<16)|(Math.round(g*255)<<8)|Math.round(b*255); }

  spawn(room) {
    this.isAlive = true; this.isSpawned = true;
    const w = room.config.options.width, h = room.config.options.height;
    this.pos.x = Math.random() * (w-400) + 200;
    this.pos.y = Math.random() * (h-400) + 200;
    this.vel.x = 0; this.vel.y = 0; this.invincibleDur = 2.0; this.curDash = this.maxDash; this.size = 36; this.level = 1;
    for (let i=0;i<this.parts.length;i++){ this.parts[i].x = this.pos.x - i*20; this.parts[i].y = this.pos.y; this.parts[i].vx = 0; this.parts[i].vy = 0; this.parts[i].rot = this.angle; }
    this.lastPosition = this.pos.clone();
  }

  update(dt, validator) {
    if (!this.isAlive) {
      if (Date.now() > this.respawnTime) {
        const room = global.gameServer.rooms.get(this.currentRoom);
        if (room) this.spawn(room);
      }
      return;
    }
    this.invincibleDur = Math.max(0, this.invincibleDur - dt);
    if (this.curDash < this.maxDash) {
      this.overDash += dt * this.dashRegenRate;
      if (this.overDash >= 1.0) { this.curDash = Math.min(this.maxDash, this.curDash + 1); this.overDash = 0; }
    }
    this.processMovement(dt); this.updateParts(dt); this.clampToWorld(); this.updateSize();
    this.lastPosition = this.pos.clone();
  }

  processMovement(dt) {
    const dx = this.targetX - this.pos.x, dy = this.targetY - this.pos.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist > 10) {
      const nx = dx / dist, ny = dy / dist;
      this.vel.x += nx * CONFIG.acceleration * dt;
      this.vel.y += ny * CONFIG.acceleration * dt;
      const sp = Math.sqrt(this.vel.x*this.vel.x + this.vel.y*this.vel.y);
      if (sp > this.maxSpeed) { this.vel.x = (this.vel.x/sp)*this.maxSpeed; this.vel.y = (this.vel.y/sp)*this.maxSpeed; }
      this.angle = Math.atan2(dy, dx);
    }
    this.vel.x *= CONFIG.friction; this.vel.y *= CONFIG.friction;
    this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt;
    this.speed = Math.sqrt(this.vel.x*this.vel.x + this.vel.y*this.vel.y);
  }

  updateParts(dt){
    this.parts[0].x = this.pos.x; this.parts[0].y = this.pos.y; this.parts[0].rot = this.angle;
    this.parts[0].vx = this.vel.x; this.parts[0].vy = this.vel.y;
    for (let i=1;i<this.parts.length;i++){
      const part=this.parts[i], prev=this.parts[i-1];
      if (i !== this.breakPoint) {
        const seg = 25 + this.size*0.2;
        const tx = prev.x - Math.cos(prev.rot)*seg, ty = prev.y - Math.sin(prev.rot)*seg;
        part.x += (tx - part.x) * 0.4; part.y += (ty - part.y) * 0.4;
        const dx = prev.x - part.x, dy = prev.y - part.y; part.rot = Math.atan2(dy, dx); part.oriRot = part.rot;
      } else {
        part.update(dt); part.vx *= 0.98; part.vy *= 0.98; part.vt *= 0.95;
      }
    }
  }

  clampToWorld() {
    const room = global.gameServer.rooms.get(this.currentRoom); if (!room) return;
    const margin = 100;
    this.pos.x = Math.max(margin, Math.min(room.config.options.width - margin, this.pos.x));
    this.pos.y = Math.max(margin, Math.min(room.config.options.height - margin, this.pos.y));
  }

  updateSize() {
    this.level = Math.floor(this.score / 100) + 1;
    this.size = 36 + (this.level - 1) * 3;
    this.maxSpeed = Math.max(80, 150 - (this.level - 1) * 5);
  }

  setTarget(x, y, validator) {
    const room = global.gameServer.rooms.get(this.currentRoom); if (!room) return;
    this.targetX = Math.max(0, Math.min(room.config.options.width, x));
    this.targetY = Math.max(0, Math.min(room.config.options.height, y));
  }

  useDash(validator) {
    if (!validator.validateDash(this)) return false;
    if (this.curDash > 0) {
      this.curDash--; this.lastDashTime = Date.now();
      this.vel.x += Math.cos(this.angle) * CONFIG.dashPower;
      this.vel.y += Math.sin(this.angle) * CONFIG.dashPower;
      return true;
    }
    return false;
  }

  takeDamage(amount, attacker=null) {
    if (this.invincibleDur > 0) return false;
    if (attacker && attacker !== this) { attacker.kills++; attacker.score += 100 + this.level*20; }
    this.die(); return true;
  }

  die() {
    this.isAlive = false; this.isSpawned = false; this.deaths++; this.respawnTime = Date.now() + 3000;
    try {
      const rip = Buffer.from([OPCODES.RIP]);
      if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(rip);
    } catch(e){}
  }
}

// ----------------- Food + GameRoom (kept) -----------------
class Food {
  constructor(x,y,value=1){ this.id = Date.now() + Math.floor(Math.random()*1000); this.x=x;this.y=y;this.value=value; this.size = value>1 ? 8 : 4; this.color = value>1 ? 0xff6b6b : 0x4ecdc4; }
}

class GameRoom {
  constructor(config){ this.id=config.id; this.name=config.name; this.config=config; this.players=new Map(); this.foods=[]; this.validator=new InputValidator(); this.generateFood(300); }
  generateFood(count){ for(let i=0;i<count;i++){ const x=Math.random()*(this.config.options.width-200)+100; const y=Math.random()*(this.config.options.height-200)+100; const value = Math.random()<0.1?3:1; this.foods.push(new Food(x,y,value)); } }
  addPlayer(player){ this.players.set(player.id, player); player.currentRoom = this.id; this.config.playerCount = this.players.size; player.spawn(this); }
  removePlayer(playerId){ const p = this.players.get(playerId); if(p){ this.players.delete(playerId); this.config.playerCount = this.players.size; } }
  update(dt){ for (const p of this.players.values()) p.update(dt, this.validator); this.checkCollisions(); if (this.foods.length < 250) this.generateFood(10); }
  checkCollisions(){
    const alive = Array.from(this.players.values()).filter(p=>p.isAlive);
    for (let i=0;i<alive.length;i++){
      for (let j=i+1;j<alive.length;j++){
        const p1=alive[i], p2=alive[j];
        const d = p1.pos.distance(p2.pos); const colD = (p1.size + p2.size)*0.6;
        if (d < colD) {
          const diff = p1.size - p2.size; const threshold = 10;
          if (diff > threshold) p2.takeDamage(CONFIG.collisionDamage, p1); else if (diff < -threshold) p1.takeDamage(CONFIG.collisionDamage, p2);
        }
      }
    }
    for (const player of alive) {
      for (let i=this.foods.length-1;i>=0;i--){
        const food=this.foods[i];
        const dist = Math.hypot(player.pos.x - food.x, player.pos.y - food.y);
        if (dist < player.size/2 + food.size) {
          player.score += food.value * 10;
          this.foods.splice(i,1);
          if (Math.random() < 0.7) {
            const x = Math.random()*(this.config.options.width-200)+100;
            const y = Math.random()*(this.config.options.height-200)+100;
            const value = Math.random()<0.1?3:1;
            this.foods.push(new Food(x,y,value));
          }
        }
      }
    }
  }
}

// ----------------- Packet encoder (keeps same encoding, small safety masks) -----------------
class PacketEncoder {
  static encodeUintAngle(angle) { return Math.floor(((angle/Math.PI + 1)/2) * 255) & 0xFF; }

  static encodeSetElements(room) {
    const players = Array.from(room.players.values()).filter(p => p.isAlive && p.isSpawned);
    const foods = room.foods.slice(0,100);
    let bufferSize = 64;
    players.forEach(p => bufferSize += 64 + Buffer.byteLength(p.name,'utf8') + (p.parts.length * 5));
    bufferSize += foods.length * 20;
    const buffer = Buffer.alloc(bufferSize);
    let off = 0;
    buffer.writeUInt8(OPCODES.SET_ELEMENTS, off++); // opcode
    buffer.writeUInt16LE(Date.now() & 0xFFFF, off); off += 2;
    buffer.writeUInt8(0, off++); // worldFlags
    for (const p of players) off = PacketEncoder._encodeFishElement(buffer, off, p);
    for (const f of foods) off = PacketEncoder._encodeFoodElement(buffer, off, f);
    return buffer.slice(0, off);
  }

  static _encodeFishElement(buffer, offset, player) {
    buffer.writeUInt8(ELEMENT_TYPES.FISH, offset++);
    let pid = 0;
    if (typeof player.id === 'number') pid = player.id >>> 0;
    else {
      const s = String(player.id);
      try { pid = parseInt(s.slice(-8).split('').map(c=>c.charCodeAt(0).toString(16)).join(''), 16) & 0xFFFFFFFF; } catch(e){ pid = 0; }
    }
    buffer.writeUInt32LE(pid, offset); offset += 4;
    buffer.writeUInt8((player.color >> 16) & 0xFF, offset++); buffer.writeUInt8((player.color >> 8) & 0xFF, offset++); buffer.writeUInt8(player.color & 0xFF, offset++);
    const nameBytes = Buffer.from(player.name, 'utf8'); const nameLength = Math.min(nameBytes.length, 20);
    nameBytes.copy(buffer, offset, 0, nameLength); offset += nameLength; buffer.writeUInt8(0, offset++);
    buffer.writeUInt8((player.team & 0xFF) | ((player.level & 0x1F) << 3), offset++);
    buffer.writeUInt8(Math.floor(player.alpha * 255) & 0xFF, offset++);
    buffer.writeUInt8((player.maxDash & 0xF) | ((player.curDash & 0xF) << 4), offset++);
    buffer.writeUInt8(Math.floor(player.overDash * 255) & 0xFF, offset++);
    buffer.writeUInt8(Math.floor(player.tuskRatio * 127) & 0xFF, offset++);
    buffer.writeUInt8(player.decoration & 0xFF, offset++);
    buffer.writeFloatLE(player.parts[0].x, offset); offset += 4;
    buffer.writeFloatLE(player.parts[0].y, offset); offset += 4;
    const sp = Math.sqrt(player.parts[0].vx*player.parts[0].vx + player.parts[0].vy*player.parts[0].vy);
    const ang = Math.atan2(player.parts[0].vy, player.parts[0].vx);
    buffer.writeUInt16LE(Math.min(Math.floor(sp), 65535), offset); offset += 2;
    buffer.writeUInt8(PacketEncoder.encodeUintAngle(ang), offset++);
    buffer.writeUInt8(PacketEncoder.encodeUintAngle(player.parts[0].rot), offset++);
    buffer.writeUInt8(player.skincode & 0xFF, offset++);
    buffer.writeUInt8(Math.floor(player.invincibleDur * 255) & 0xFF, offset++);
    buffer.writeUInt8(Math.max(0, Math.min(255, player.parts.length - 1)), offset++);
    for (let i=1;i<player.parts.length;i++){
      const part = player.parts[i];
      if (i !== player.breakPoint) { buffer.writeUInt8(PacketEncoder.encodeUintAngle(part.rot), offset++); }
      else { buffer.writeFloatLE(part.x, offset); offset +=4; buffer.writeFloatLE(part.y, offset); offset +=4; buffer.writeFloatLE(part.vx, offset); offset +=4; buffer.writeFloatLE(part.vy, offset); offset +=4; }
    }
    return offset;
  }

  static _encodeFoodElement(buffer, offset, food) {
    buffer.writeUInt8(ELEMENT_TYPES.FOOD, offset++); buffer.writeUInt32LE(food.id & 0xFFFFFFFF, offset); offset += 4;
    buffer.writeFloatLE(food.x, offset); offset += 4; buffer.writeFloatLE(food.y, offset); offset += 4;
    buffer.writeUInt8(food.value & 0xFF, offset++); buffer.writeUInt8(food.size & 0xFF, offset++);
    buffer.writeUInt8((food.color >> 16) & 0xFF, offset++); buffer.writeUInt8((food.color >> 8) & 0xFF, offset++); buffer.writeUInt8(food.color & 0xFF, offset++);
    return offset;
  }

  static encodeLeaderBoard(players) {
    const top = Array.from(players.values()).filter(p=>p.isAlive).sort((a,b)=>b.score-a.score).slice(0,10);
    let size = 3 + top.length * 30; const buf = Buffer.alloc(size); let off = 0;
    buf.writeUInt8(OPCODES.LEADER_BOARD, off++); buf.writeUInt8(top.length, off++);
    for (const p of top) { buf.writeUInt8(p.level & 0xFF, off++); const nb=Buffer.from(p.name,'utf8'); const len=Math.min(nb.length,25); nb.copy(buf,off,0,len); off += len; buf.writeUInt8(0,off++); }
    buf.writeUInt8(top.length, off++);
    for (const p of top) buf.writeUInt8(Math.min(p.level,255), off++);
    return buf.slice(0, off);
  }
}

// ----------------- Rooms config (kept) -----------------
const ROOMS_CONFIG = [
  { options:{width:6400,height:6400,cellWidth:1280,hasIndicator:false,isPriority:true,fieldType:0,desirablePlayerNum:25,hasSlowFactor:false}, name:"Large 1", id:0, playerCount:0 },
  { options:{width:6400,height:6400,cellWidth:1280,hasIndicator:false,isPriority:true,fieldType:0,desirablePlayerNum:25,hasSlowFactor:false}, name:"Large 2", id:1, playerCount:0 },
  { options:{width:6400,height:6400,cellWidth:1280,hasIndicator:false,isPriority:false,fieldType:0,desirablePlayerNum:9,hasSlowFactor:false}, name:"Sparse", id:2, playerCount:0 },
  { options:{width:3840,height:3840,cellWidth:1280,hasIndicator:false,isPriority:false,fieldType:0,desirablePlayerNum:9,hasSlowFactor:false}, name:"Small 1", id:3, playerCount:0 },
  { options:{width:3840,height:3840,cellWidth:1280,hasIndicator:false,isPriority:true,fieldType:0,desirablePlayerNum:6,hasSlowFactor:false}, name:"Small 2", id:4, playerCount:0 },
  { options:{width:6400,height:3840,cellWidth:1280,hasIndicator:true,isPriority:false,fieldType:1,desirablePlayerNum:25,hasSlowFactor:true}, name:"Narwhale Ball!", id:5, playerCount:0 },
  { options:{width:6400,height:5120,cellWidth:1280,hasIndicator:true,isPriority:false,fieldType:3,desirablePlayerNum:25,hasSlowFactor:true}, name:"Narwhale Egg Hunt!", id:7, playerCount:0 },
  { options:{width:6400,height:6400,cellWidth:1280,hasIndicator:true,isPriority:false,fieldType:4,desirablePlayerNum:25,hasSlowFactor:true}, name:"Team Deathmatch", id:8, playerCount:0 },
];

// ----------------- Main server class -----------------
class NarwhaleGameServer {
  constructor() {
    this.wss = null;
    this.players = new Map();
    this.rooms = new Map();
    this.lastTick = Date.now();
    this.validator = new InputValidator();
    for (const cfg of ROOMS_CONFIG) this.rooms.set(cfg.id, new GameRoom(cfg));
    global.gameServer = this;
  }

  start() {
    // Create server (PORT from CONFIG.port)
    try {
      this.wss = new WebSocket.Server({ port: CONFIG.port, host: '0.0.0.0' });
    } catch (e) {
      console.error('Failed to open server on port', CONFIG.port, e);
      process.exit(1);
    }

    this.wss.on('connection', (socket, req) => this.handleNewConnection(socket, req));
    this._startGameLoop();
    console.log(`🚀 Servidor iniciado en puerto ${CONFIG.port}`);
    console.log(`🔄 Game loop iniciado a ${CONFIG.tickRate} FPS`);
  }

  handleNewConnection(socket, req) {
    const playerId = Date.now() + Math.floor(Math.random()*1000);
    socket.playerId = playerId;
    socket.currentRoom = null;
    socket.binaryType = 'arraybuffer';

    console.log(`New WS connection: playerId=${playerId} remote=${req.socket.remoteAddress}`);

    socket.on('message', (data) => this.handleMessage(socket, data));
    socket.on('close', (code, reason) => { console.log(`Socket closed: playerId=${socket.playerId} code=${code} reason=${reason||''}`); this.handleDisconnection(socket); });
    socket.on('error', (err) => { console.warn('Socket error', err && err.message); this.handleDisconnection(socket); });
  }

  // Note: data may be Buffer (node) or ArrayBuffer client-side -> convert safely
  handleMessage(socket, data) {
    if (!data || data.length === 0) return;
    let buf;
    if (Buffer.isBuffer(data)) buf = data;
    else if (data instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(data));
    else buf = Buffer.from(String(data)); // defensive

    const opcode = buf.readUInt8(0);
    try {
      switch (opcode) {
        case OPCODES.GET_LOBBIES: this.handleGetLobbies(socket); break;
        case OPCODES.JOIN: this.handleJoin(socket, buf); break;
        case OPCODES.START: this.handleStart(socket, buf); break;
        case OPCODES.UPDATE_TARGET: this.handleUpdateTarget(socket, buf); break;
        case OPCODES.INPUT: this.handleInput(socket, buf); break;
        case OPCODES.PING: this.handlePing(socket, buf); break;
        case OPCODES.LEAVE: this.handleLeave(socket); break;
        default: /* ignore unknown */ break;
      }
    } catch (e) { console.error('Error processing message', e && e.stack); }
  }

  handleGetLobbies(socket) {
    const roomsData = ROOMS_CONFIG.map(cfg => {
      const r = this.rooms.get(cfg.id);
      return Object.assign({}, cfg, { playerCount: r ? r.players.size : 0 });
    });
    const json = JSON.stringify(roomsData);
    const resp = Buffer.concat([ Buffer.from([OPCODES.GET_LOBBIES]), Buffer.from(json,'utf8'), Buffer.from([0x00]) ]);
    socket.send(resp);
  }

  handleJoin(socket, buf) {
    if (buf.length < 5) return;
    const roomId = buf.readUInt32LE(1);
    const room = this.rooms.get(roomId); if (!room) return;
    socket.currentRoom = roomId;
    const res = Buffer.alloc(5); res.writeUInt8(OPCODES.JOIN,0); res.writeUInt32LE(roomId,1); socket.send(res);
    console.log(`Player ${socket.playerId} joined room ${roomId}`);
  }

  // IMPORTANT: this is the most-sensitive function the client expects a particular START response format.
  // I created a safe, compatible START handler that:
  //  - reads skincode (1 byte), color (4 bytes little-endian), name (null-terminated after offset 9)
  //  - constructs a compact ACK/START response packet consistent with original client expectations.
  handleStart(socket, buf) {
    if (buf.length < 9) return;
    let off = 1;
    const skincode = buf.readUInt8(off); off++;
    const colorcode = buf.readUInt32LE(off); off += 4;
    // read name after offset 9 (safe)
    let playerName = 'Player';
    if (buf.length > 9) {
      const nameSlice = buf.slice(9);
      const nullIdx = nameSlice.indexOf(0);
      playerName = nullIdx !== -1 ? nameSlice.slice(0, nullIdx).toString('utf8') : nameSlice.toString('utf8');
      playerName = playerName.substring(0,16) || 'Player';
    }

    const playerId = socket.playerId;
    const player = new Player(playerId, socket, playerName);
    player.skincode = skincode;
    player.color = colorcode;
    this.players.set(playerId, player);

    if (socket.currentRoom !== null) {
      const room = this.rooms.get(socket.currentRoom);
      if (room) { room.addPlayer(player); player.spawn(room); }
    }

    // CREATE START/ACK packet — format chosen to be compatible with the original client START response.
    // Packet layout:
    // [opcode=18][uid (2 bytes)][color (4 bytes)][skin (1)][0][0][0][nameLen (1)] [name bytes] [0 terminator][flag 1]
    const nameBuf = Buffer.from(playerName, 'utf8');
    const packet = Buffer.alloc(19 + nameBuf.length);
    let i = 0;
    packet[i++] = OPCODES.START;                      // opcode 18
    packet.writeUInt16LE(playerId & 0xFFFF, i); i += 2; // 2 bytes uid (client expects a short here)
    packet.writeUInt32LE(colorcode, i); i += 4;         // color
    packet[i++] = skincode;                             // skin
    packet[i++] = 0; packet[i++] = 0; packet[i++] = 0;  // zeros (preserve fields)
    packet[i++] = nameBuf.length & 0xFF;                // name len
    nameBuf.copy(packet, i); i += nameBuf.length;
    packet[i++] = 0;                                    // null term
    packet[i++] = 1;                                    // flag (set to 1)
    // send
    socket.send(packet);
    console.log(`SPAWN PACKET SENT → ${playerName} (len=${packet.length})`);

    // send small immediate world update (so the client won't think server is dead)
    setTimeout(() => {
      if (socket.currentRoom !== null) {
        const room = this.rooms.get(socket.currentRoom);
        if (room) {
          const state = PacketEncoder.encodeSetElements(room);
          if (state.length > 0) socket.send(state);
        }
      }
    }, 80);
  }

  handleUpdateTarget(socket, buf) {
    if (buf.length >= 9) {
      if (!this.validator.validateInputRate(socket.playerId)) return;
      const x = buf.readFloatLE(1); const y = buf.readFloatLE(5);
      const player = this.players.get(socket.playerId);
      if (player) player.setTarget(x,y,this.validator);
    }
  }

  handleInput(socket, buf) {
    if (buf.length >= 2) {
      if (!this.validator.validateInputRate(socket.playerId)) return;
      const control = buf.readUInt8(1);
      const player = this.players.get(socket.playerId);
      if (player && (control & 0x10)) player.useDash(this.validator);
    }
  }

  handlePing(socket, buf) {
    if (buf.length >= 5) {
      const ts = buf.readFloatLE(1);
      const resp = Buffer.alloc(5); resp.writeUInt8(OPCODES.PING,0); resp.writeFloatLE(ts,1);
      socket.send(resp);
    }
  }

  handleLeave(socket) { this.handleDisconnection(socket); }

  handleDisconnection(socket) {
    const player = this.players.get(socket.playerId);
    if (player && player.currentRoom !== null) {
      const room = this.rooms.get(player.currentRoom);
      if (room) room.removePlayer(socket.playerId);
    }
    this.players.delete(socket.playerId);
  }

  _startGameLoop() {
    const target = 1000 / CONFIG.tickRate;
    this.lastTick = Date.now();
    setInterval(() => {
      const now = Date.now();
      const dt = (now - this.lastTick) / 1000;
      this.lastTick = now;
      for (const room of this.rooms.values()) room.update(dt);
      this._sendUpdates();
    }, target);
  }

  _sendUpdates() {
    for (const room of this.rooms.values()) {
      if (room.players.size > 0) {
        const state = PacketEncoder.encodeSetElements(room);
        for (const player of room.players.values()) {
          try { if (player.socket && player.socket.readyState === WebSocket.OPEN) player.socket.send(state); } catch(e){}
        }
      }
    }
    // leaderboard every ~5 seconds (approx)
    if (Date.now() % 5000 < 1000 / CONFIG.tickRate) {
      for (const room of this.rooms.values()) {
        if (room.players.size > 1) {
          const lb = PacketEncoder.encodeLeaderBoard(room.players);
          for (const player of room.players.values()) {
            try { if (player.socket && player.socket.readyState === WebSocket.OPEN) player.socket.send(lb); } catch(e){}
          }
        }
      }
    }
  }
}

// ----------------- Start server -----------------
const server = new NarwhaleGameServer();
server.start();

console.log(`
╔════════════════════════════════════════════════════════════════╗
║              🐋 SERVIDOR NARWHALE AUTORITATIVO 🌊              ║
╠════════════════════════════════════════════════════════════════╣
║ Puerto: ${CONFIG.port}                                         ║
║ Tick Rate: ${CONFIG.tickRate} FPS                              ║
║ Anti-Cheat: ACTIVADO                                           ║
║ Física: Servidor Autoritativo                                  ║
║ 🎮 Servidor listo para recibir conexiones                      ║
╚════════════════════════════════════════════════════════════════╝
`);
module.exports = { server };
