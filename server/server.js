const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// Server Configuration
const PORT = process.env.PORT || 3000;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Game Configuration
const gameConfig = {
    arena: {
        width: 1000,
        height: 600
    },
    player: {
        size: 30,
        speed: 200,
        maxHealth: 100,
        reloadTime: 1000,
        startPositions: [
            { x: 100, y: 300 },
            { x: 900, y: 300 }
        ]
    },
    projectile: {
        speed: 500,
        damage: 5,
        size: 5
    },
    powerups: {
        laser: { damage: 15, cost: 20 },
        explosive: { damage: 20, cost: 20, radius: 50, explosionDelay: 400 },
        shield: { absorption: 20, cost: 20, duration: 10000 }
    },
    cover: {
        layouts: [
            { x: 200, y: 200, width: 60, height: 200 },
            { x: 800, y: 200, width: 60, height: 200 },
            { x: 400, y: 100, width: 200, height: 60 },
            { x: 400, y: 440, width: 200, height: 60 },
            { x: 450, y: 250, width: 100, height: 100 }
        ]
    }
};

// Game State Management
class GameRoom {
    constructor(code, host) {
        this.code = code;
        this.host = host;
        this.players = new Map();
        this.gameState = {
            started: false,
            covers: [...gameConfig.cover.layouts],
            projectiles: [],
            lastUpdate: Date.now()
        };
        this.updateInterval = null;
    }

    addPlayer(id, ws, name) {
        if (this.players.size >= 2) return false;
        
        const playerIndex = this.players.size;
        const position = gameConfig.player.startPositions[playerIndex];
        
        this.players.set(id, {
            id: id,
            ws: ws,
            name: name,
            x: position.x,
            y: position.y,
            rotation: playerIndex === 0 ? 0 : Math.PI,
            health: gameConfig.player.maxHealth,
            points: 0,
            lastShot: 0,
            reloading: false,
            shield: 0,
            velocity: { x: 0, y: 0 }
        });

        return true;
    }

    removePlayer(id) {
        this.players.delete(id);
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    startGame() {
        if (this.players.size !== 2) return false;
        
        this.gameState.started = true;
        
        // Send game start to all players
        const playerArray = Array.from(this.players.values());
        playerArray.forEach((player, index) => {
            const otherPlayer = playerArray[1 - index];
            player.ws.send(JSON.stringify({
                type: 'gameStart',
                localPlayer: {
                    id: player.id,
                    name: player.name,
                    x: player.x,
                    y: player.y,
                    health: player.health,
                    rotation: player.rotation
                },
                enemyPlayer: {
                    id: otherPlayer.id,
                    name: otherPlayer.name,
                    x: otherPlayer.x,
                    y: otherPlayer.y,
                    health: otherPlayer.health,
                    rotation: otherPlayer.rotation
                },
                covers: this.gameState.covers
            }));
        });

        // Start game update loop
        this.updateInterval = setInterval(() => this.update(), 1000 / 60);
        return true;
    }

    update() {
        const now = Date.now();
        const deltaTime = (now - this.gameState.lastUpdate) / 1000;
        this.gameState.lastUpdate = now;

        // Update projectiles
        this.gameState.projectiles = this.gameState.projectiles.filter(proj => {
            proj.x += proj.vx * deltaTime;
            proj.y += proj.vy * deltaTime;

            // Check boundaries
            if (proj.x < 0 || proj.x > gameConfig.arena.width || 
                proj.y < 0 || proj.y > gameConfig.arena.height) {
                return false;
            }

            // Check cover collisions
            for (let cover of this.gameState.covers) {
                if (this.checkCollision(proj, cover)) {
                    if (proj.type === 'explosive') {
                        this.explode(proj.x, proj.y, proj.ownerId);
                    }
                    return false;
                }
            }

            // Check player collisions
            for (let [id, player] of this.players) {
                if (id !== proj.ownerId && this.checkCircleRectCollision(proj, player)) {
                    this.hitPlayer(id, proj.damage, proj.ownerId);
                    if (proj.type === 'explosive') {
                        this.explode(proj.x, proj.y, proj.ownerId);
                    }
                    return false;
                }
            }

            // Check explosive timer
            if (proj.type === 'explosive' && now - proj.createdAt > gameConfig.powerups.explosive.explosionDelay) {
                this.explode(proj.x, proj.y, proj.ownerId);
                return false;
            }

            return true;
        });

        // Update reload states
        for (let [id, player] of this.players) {
            if (player.reloading && now - player.lastShot >= gameConfig.player.reloadTime) {
                player.reloading = false;
            }
            player.reloadProgress = player.reloading ? 
                (now - player.lastShot) / gameConfig.player.reloadTime : 1;
        }

        // Send state update
        this.broadcast({
            type: 'gameState',
            state: {
                players: Object.fromEntries(
                    Array.from(this.players.entries()).map(([id, p]) => [
                        id,
                        {
                            x: p.x,
                            y: p.y,
                            rotation: p.rotation,
                            health: p.health,
                            shield: p.shield,
                            reloading: p.reloading,
                            reloadProgress: p.reloadProgress
                        }
                    ])
                ),
                projectiles: this.gameState.projectiles.map(p => ({
                    x: p.x,
                    y: p.y,
                    type: p.type,
                    color: p.color
                })),
                covers: this.gameState.covers
            }
        });
    }

    handlePlayerMove(playerId, dx, dy, deltaTime) {
        const player = this.players.get(playerId);
        if (!player) return;

        const speed = gameConfig.player.speed * deltaTime;
        const newX = player.x + dx * speed;
        const newY = player.y + dy * speed;

        // Check boundaries
        const halfSize = gameConfig.player.size / 2;
        if (newX - halfSize < 0 || newX + halfSize > gameConfig.arena.width ||
            newY - halfSize < 0 || newY + halfSize > gameConfig.arena.height) {
            return;
        }

        // Check cover collisions
        let canMove = true;
        for (let cover of this.gameState.covers) {
            if (this.checkRectCollision(
                { x: newX - halfSize, y: newY - halfSize, width: gameConfig.player.size, height: gameConfig.player.size },
                cover
            )) {
                canMove = false;
                break;
            }
        }

        if (canMove) {
            player.x = newX;
            player.y = newY;
        }

        // Update rotation based on movement direction
        if (dx !== 0 || dy !== 0) {
            player.rotation = Math.atan2(dy, dx);
        }
    }

    handlePlayerAim(playerId, mouseX, mouseY) {
        const player = this.players.get(playerId);
        if (!player) return;

        const angle = Math.atan2(mouseY - player.y, mouseX - player.x);
        player.rotation = angle;
    }

    handlePlayerShoot(playerId, targetX, targetY, powerupType = null) {
        const player = this.players.get(playerId);
        if (!player || player.reloading) return;

        const now = Date.now();
        player.lastShot = now;
        player.reloading = true;

        const angle = Math.atan2(targetY - player.y, targetX - player.x);
        const speed = powerupType === 'laser' ? 2000 : gameConfig.projectile.speed;
        
        const projectile = {
            id: uuidv4(),
            ownerId: playerId,
            x: player.x + Math.cos(angle) * gameConfig.player.size,
            y: player.y + Math.sin(angle) * gameConfig.player.size,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            damage: this.getProjectileDamage(powerupType),
            type: powerupType,
            color: this.getProjectileColor(powerupType),
            createdAt: now
        };

        this.gameState.projectiles.push(projectile);
    }

    handlePowerup(playerId, powerupNum) {
        const player = this.players.get(playerId);
        if (!player || player.points < 20) return;

        player.points -= 20;

        switch(powerupNum) {
            case 1: // Laser
                // Next shot will be laser
                player.nextShotType = 'laser';
                break;
            case 2: // Explosive
                player.nextShotType = 'explosive';
                break;
            case 3: // Shield
                player.shield = gameConfig.powerups.shield.absorption;
                setTimeout(() => { player.shield = 0; }, gameConfig.powerups.shield.duration);
                break;
        }
    }

    getProjectileDamage(type) {
        switch(type) {
            case 'laser': return gameConfig.powerups.laser.damage;
            case 'explosive': return gameConfig.powerups.explosive.damage;
            default: return gameConfig.projectile.damage;
        }
    }

    getProjectileColor(type) {
        switch(type) {
            case 'laser': return '#00ff00';
            case 'explosive': return '#ff6600';
            default: return '#ffff00';
        }
    }

    explode(x, y, ownerId) {
        const radius = gameConfig.powerups.explosive.radius;
        
        // Damage players in radius
        for (let [id, player] of this.players) {
            const distance = Math.sqrt(Math.pow(player.x - x, 2) + Math.pow(player.y - y, 2));
            if (distance <= radius) {
                this.hitPlayer(id, gameConfig.powerups.explosive.damage, ownerId);
            }
        }

        // Destroy covers in radius
        this.gameState.covers = this.gameState.covers.filter(cover => {
            const centerX = cover.x + cover.width / 2;
            const centerY = cover.y + cover.height / 2;
            const distance = Math.sqrt(Math.pow(centerX - x, 2) + Math.pow(centerY - y, 2));
            return distance > radius;
        });
    }

    hitPlayer(playerId, damage, attackerId) {
        const player = this.players.get(playerId);
        const attacker = this.players.get(attackerId);
        if (!player || !attacker) return;

        // Apply shield first
        if (player.shield > 0) {
            const absorbed = Math.min(damage, player.shield);
            player.shield -= absorbed;
            damage -= absorbed;
        }

        player.health -= damage;
        attacker.points += damage;

        // Send hit notification
        this.broadcast({
            type: 'playerHit',
            playerId: playerId,
            health: player.health,
            damage: damage
        });

        // Check for game over
        if (player.health <= 0) {
            this.endGame(attackerId);
        }
    }

    endGame(winnerId) {
        clearInterval(this.updateInterval);
        this.broadcast({
            type: 'gameOver',
            winner: winnerId
        });
        this.gameState.started = false;
    }

    checkCollision(projectile, rect) {
        return projectile.x >= rect.x && 
               projectile.x <= rect.x + rect.width &&
               projectile.y >= rect.y && 
               projectile.y <= rect.y + rect.height;
    }

    checkCircleRectCollision(circle, rect) {
        const halfSize = gameConfig.player.size / 2;
        return circle.x >= rect.x - halfSize && 
               circle.x <= rect.x + halfSize &&
               circle.y >= rect.y - halfSize && 
               circle.y <= rect.y + halfSize;
    }

    checkRectCollision(rect1, rect2) {
        return rect1.x < rect2.x + rect2.width &&
               rect1.x + rect1.width > rect2.x &&
               rect1.y < rect2.y + rect2.height &&
               rect1.y + rect1.height > rect2.y;
    }

    broadcast(data) {
        const message = JSON.stringify(data);
        for (let [id, player] of this.players) {
            if (player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(message);
            }
        }
    }
}

// Global game rooms
const gameRooms = new Map();
const playerRooms = new Map();

// WebSocket connection handler
wss.on('connection', (ws) => {
    const playerId = uuidv4();
    let playerName = 'Spieler';
    let currentRoom = null;

    console.log(`Player connected: ${playerId}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'setName':
                    playerName = data.name || 'Spieler';
                    break;

                case 'createLobby':
                    if (currentRoom) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Bereits in einer Lobby' }));
                        break;
                    }
                    
                    const lobbyCode = generateLobbyCode();
                    const room = new GameRoom(lobbyCode, playerId);
                    room.addPlayer(playerId, ws, data.playerName || playerName);
                    
                    gameRooms.set(lobbyCode, room);
                    playerRooms.set(playerId, lobbyCode);
                    currentRoom = room;
                    
                    ws.send(JSON.stringify({
                        type: 'lobbyCreated',
                        lobbyCode: lobbyCode
                    }));
                    
                    ws.send(JSON.stringify({
                        type: 'lobbyUpdate',
                        players: room.players.size
                    }));
                    break;

                case 'joinLobby':
                    if (currentRoom) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Bereits in einer Lobby' }));
                        break;
                    }
                    
                    const joinRoom = gameRooms.get(data.lobbyCode);
                    if (!joinRoom) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Lobby nicht gefunden' }));
                        break;
                    }
                    
                    if (joinRoom.players.size >= 2) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Lobby ist voll' }));
                        break;
                    }
                    
                    joinRoom.addPlayer(playerId, ws, data.playerName || playerName);
                    playerRooms.set(playerId, data.lobbyCode);
                    currentRoom = joinRoom;
                    
                    ws.send(JSON.stringify({
                        type: 'lobbyJoined',
                        lobbyCode: data.lobbyCode
                    }));
                    
                    // Notify all players in room
                    joinRoom.broadcast({
                        type: 'lobbyUpdate',
                        players: joinRoom.players.size
                    });
                    
                    // Start game if room is full
                    if (joinRoom.players.size === 2) {
                        setTimeout(() => joinRoom.startGame(), 1000);
                    }
                    break;

                case 'leaveLobby':
                    if (currentRoom) {
                        currentRoom.removePlayer(playerId);
                        playerRooms.delete(playerId);
                        
                        if (currentRoom.players.size === 0) {
                            gameRooms.delete(currentRoom.code);
                        } else {
                            currentRoom.broadcast({
                                type: 'lobbyUpdate',
                                players: currentRoom.players.size
                            });
                        }
                        
                        currentRoom = null;
                    }
                    break;

                case 'getLobbies':
                    const lobbies = Array.from(gameRooms.values())
                        .filter(room => !room.gameState.started && room.players.size < 2)
                        .map(room => ({
                            code: room.code,
                            name: `Lobby ${room.code}`,
                            players: room.players.size
                        }));
                    
                    ws.send(JSON.stringify({
                        type: 'lobbyList',
                        lobbies: lobbies
                    }));
                    break;

                case 'move':
                    if (currentRoom && currentRoom.gameState.started) {
                        currentRoom.handlePlayerMove(playerId, data.dx, data.dy, data.deltaTime);
                    }
                    break;

                case 'aim':
                    if (currentRoom && currentRoom.gameState.started) {
                        currentRoom.handlePlayerAim(playerId, data.mouseX, data.mouseY);
                    }
                    break;

                case 'shoot':
                    if (currentRoom && currentRoom.gameState.started) {
                        const player = currentRoom.players.get(playerId);
                        if (player) {
                            const shotType = player.nextShotType || null;
                            currentRoom.handlePlayerShoot(playerId, data.targetX, data.targetY, shotType);
                            player.nextShotType = null;
                        }
                    }
                    break;

                case 'usePowerup':
                    if (currentRoom && currentRoom.gameState.started) {
                        currentRoom.handlePowerup(playerId, data.powerup);
                    }
                    break;
            }
        } catch (error) {
            console.error('Error handling message:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Fehler beim Verarbeiten der Nachricht' }));
        }
    });

    ws.on('close', () => {
        console.log(`Player disconnected: ${playerId}`);
        
        if (currentRoom) {
            currentRoom.removePlayer(playerId);
            
            if (currentRoom.players.size === 0) {
                gameRooms.delete(currentRoom.code);
            } else if (currentRoom.gameState.started) {
                // End game if player leaves during game
                const remainingPlayer = currentRoom.players.keys().next().value;
                currentRoom.endGame(remainingPlayer);
            } else {
                currentRoom.broadcast({
                    type: 'lobbyUpdate',
                    players: currentRoom.players.size
                });
            }
        }
        
        playerRooms.delete(playerId);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for player ${playerId}:`, error);
    });
});

// Helper function to generate lobby codes
function generateLobbyCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Start server
server.listen(PORT, () => {
    console.log(`Shellshock Arena Server running on port ${PORT}`);
    console.log(`WebSocket server ready for connections`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});