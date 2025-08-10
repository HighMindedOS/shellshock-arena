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
        laser: { 
            damage: 15, 
            cost: 20,
            instant: true  // Laser is instant hit
        },
        explosive: { 
            damage: 20, 
            cost: 20, 
            radius: 80, 
            explosionDelay: 400,
            speed: 400  // Slower than normal projectile
        },
        shield: { 
            absorption: 20, 
            cost: 20, 
            duration: 10000 
        }
    },
    cover: {
        layouts: [
            { x: 200, y: 200, width: 60, height: 200, id: 'cover1' },
            { x: 800, y: 200, width: 60, height: 200, id: 'cover2' },
            { x: 400, y: 100, width: 200, height: 60, id: 'cover3' },
            { x: 400, y: 440, width: 200, height: 60, id: 'cover4' },
            { x: 450, y: 250, width: 100, height: 100, id: 'cover5' }
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
            covers: gameConfig.cover.layouts.map(c => ({...c, health: 100})),
            projectiles: [],
            explosions: [],
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
            reloadProgress: 1,
            shield: 0,
            velocity: { x: 0, y: 0 },
            usedPowerups: new Set(),
            nextShotType: null
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
        
        // Send game start to all players with full state
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
                    rotation: player.rotation,
                    points: player.points,
                    usedPowerups: Array.from(player.usedPowerups)
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
            // Skip instant projectiles (laser)
            if (proj.instant) return false;
            
            proj.x += proj.vx * deltaTime;
            proj.y += proj.vy * deltaTime;

            // Check boundaries
            if (proj.x < 0 || proj.x > gameConfig.arena.width || 
                proj.y < 0 || proj.y > gameConfig.arena.height) {
                return false;
            }

            // Check cover collisions
            for (let cover of this.gameState.covers) {
                if (this.checkProjectileCoverCollision(proj, cover)) {
                    if (proj.type === 'explosive' && !proj.exploded) {
                        proj.exploded = true;
                        this.explode(proj.x, proj.y, proj.ownerId);
                    }
                    return false;
                }
            }

            // Check player collisions
            for (let [id, player] of this.players) {
                if (id !== proj.ownerId && this.checkProjectilePlayerCollision(proj, player)) {
                    if (proj.type === 'explosive' && !proj.exploded) {
                        proj.exploded = true;
                        this.explode(proj.x, proj.y, proj.ownerId);
                    } else {
                        this.hitPlayer(id, proj.damage, proj.ownerId);
                    }
                    return false;
                }
            }

            // Check explosive timer
            if (proj.type === 'explosive' && !proj.exploded && 
                now - proj.createdAt > gameConfig.powerups.explosive.explosionDelay) {
                proj.exploded = true;
                this.explode(proj.x, proj.y, proj.ownerId);
                return false;
            }

            return true;
        });

        // Update reload states
        for (let [id, player] of this.players) {
            if (player.reloading) {
                const timeSinceShot = now - player.lastShot;
                if (timeSinceShot >= gameConfig.player.reloadTime) {
                    player.reloading = false;
                    player.reloadProgress = 1;
                } else {
                    player.reloadProgress = timeSinceShot / gameConfig.player.reloadTime;
                }
            } else {
                player.reloadProgress = 1;
            }
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
                            reloadProgress: p.reloadProgress,
                            points: p.points,
                            usedPowerups: Array.from(p.usedPowerups)
                        }
                    ])
                ),
                projectiles: this.gameState.projectiles.map(p => ({
                    x: p.x,
                    y: p.y,
                    type: p.type,
                    color: p.color
                })),
                covers: this.gameState.covers,
                explosions: this.gameState.explosions
            }
        });

        // Clear explosions after sending
        this.gameState.explosions = [];
    }

    handlePlayerMove(playerId, dx, dy, deltaTime) {
        const player = this.players.get(playerId);
        if (!player) return;

        const speed = gameConfig.player.speed * deltaTime;
        let newX = player.x + dx * speed;
        let newY = player.y + dy * speed;

        const halfSize = gameConfig.player.size / 2;

        // Check X movement
        if (newX - halfSize >= 0 && newX + halfSize <= gameConfig.arena.width) {
            let canMoveX = true;
            for (let cover of this.gameState.covers) {
                if (this.checkRectCollision(
                    { x: newX - halfSize, y: player.y - halfSize, width: gameConfig.player.size, height: gameConfig.player.size },
                    cover
                )) {
                    canMoveX = false;
                    break;
                }
            }
            if (canMoveX) player.x = newX;
        }

        // Check Y movement separately for sliding collision
        if (newY - halfSize >= 0 && newY + halfSize <= gameConfig.arena.height) {
            let canMoveY = true;
            for (let cover of this.gameState.covers) {
                if (this.checkRectCollision(
                    { x: player.x - halfSize, y: newY - halfSize, width: gameConfig.player.size, height: gameConfig.player.size },
                    cover
                )) {
                    canMoveY = false;
                    break;
                }
            }
            if (canMoveY) player.y = newY;
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

    handlePlayerShoot(playerId, targetX, targetY) {
        const player = this.players.get(playerId);
        if (!player || player.reloading) return;

        const now = Date.now();
        const powerupType = player.nextShotType;
        
        // Reset powerup after use
        player.nextShotType = null;
        
        // Set reload state
        player.lastShot = now;
        player.reloading = true;
        player.reloadProgress = 0;

        const angle = Math.atan2(targetY - player.y, targetX - player.x);
        
        // Handle instant laser
        if (powerupType === 'laser') {
            this.shootLaser(player, angle, targetX, targetY);
            
            // Send immediate projectile feedback for visual
            this.broadcast({
                type: 'instantProjectile',
                projectile: {
                    type: 'laser',
                    startX: player.x,
                    startY: player.y,
                    endX: targetX,
                    endY: targetY,
                    color: '#00ff00'
                }
            });
        } else {
            // Normal or explosive projectile
            const speed = powerupType === 'explosive' ? 
                gameConfig.powerups.explosive.speed : 
                gameConfig.projectile.speed;
            
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
                createdAt: now,
                exploded: false
            };

            this.gameState.projectiles.push(projectile);
            
            // Send immediate projectile creation event
            this.broadcast({
                type: 'projectileCreated',
                projectile: {
                    x: projectile.x,
                    y: projectile.y,
                    vx: projectile.vx,
                    vy: projectile.vy,
                    type: projectile.type,
                    color: projectile.color
                }
            });
        }
    }

    shootLaser(player, angle, targetX, targetY) {
        const maxDistance = Math.sqrt(
            Math.pow(gameConfig.arena.width, 2) + 
            Math.pow(gameConfig.arena.height, 2)
        );
        
        // Raycast to find what laser hits
        const steps = 100;
        const stepDistance = maxDistance / steps;
        
        for (let i = 1; i <= steps; i++) {
            const checkX = player.x + Math.cos(angle) * stepDistance * i;
            const checkY = player.y + Math.sin(angle) * stepDistance * i;
            
            // Check boundaries
            if (checkX < 0 || checkX > gameConfig.arena.width || 
                checkY < 0 || checkY > gameConfig.arena.height) {
                break;
            }
            
            // Check cover collision
            let hitCover = false;
            for (let cover of this.gameState.covers) {
                if (checkX >= cover.x && checkX <= cover.x + cover.width &&
                    checkY >= cover.y && checkY <= cover.y + cover.height) {
                    hitCover = true;
                    break;
                }
            }
            if (hitCover) break;
            
            // Check player collision
            for (let [id, targetPlayer] of this.players) {
                if (id === player.id) continue;
                
                const distance = Math.sqrt(
                    Math.pow(checkX - targetPlayer.x, 2) + 
                    Math.pow(checkY - targetPlayer.y, 2)
                );
                
                if (distance <= gameConfig.player.size / 2) {
                    this.hitPlayer(id, gameConfig.powerups.laser.damage, player.id);
                    return;
                }
            }
        }
    }

    handlePowerup(playerId, powerupNum) {
        const player = this.players.get(playerId);
        if (!player) return { success: false, error: 'Player not found' };
        
        // Check if already used
        if (player.usedPowerups.has(powerupNum)) {
            return { success: false, error: 'Powerup already used' };
        }
        
        // Check points
        if (player.points < 20) {
            return { success: false, error: 'Not enough points' };
        }

        // Deduct points and mark as used
        player.points -= 20;
        player.usedPowerups.add(powerupNum);

        let success = true;
        switch(powerupNum) {
            case 1: // Laser
                player.nextShotType = 'laser';
                break;
            case 2: // Explosive
                player.nextShotType = 'explosive';
                break;
            case 3: // Shield
                player.shield = gameConfig.powerups.shield.absorption;
                setTimeout(() => { 
                    if (this.players.has(playerId)) {
                        player.shield = 0;
                    }
                }, gameConfig.powerups.shield.duration);
                break;
            default:
                success = false;
        }

        if (success) {
            // Send confirmation to player
            player.ws.send(JSON.stringify({
                type: 'powerupConfirmed',
                powerupNum: powerupNum,
                newPoints: player.points,
                usedPowerups: Array.from(player.usedPowerups)
            }));
        }

        return { success };
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
        
        // Add explosion to state for visual
        this.gameState.explosions.push({ x, y, radius });
        
        // Damage players in radius
        for (let [id, player] of this.players) {
            const distance = Math.sqrt(
                Math.pow(player.x - x, 2) + 
                Math.pow(player.y - y, 2)
            );
            if (distance <= radius) {
                const damage = Math.floor(
                    gameConfig.powerups.explosive.damage * (1 - distance / radius)
                );
                if (damage > 0) {
                    this.hitPlayer(id, damage, ownerId);
                }
            }
        }

        // Damage or destroy covers that overlap with explosion
        this.gameState.covers = this.gameState.covers.filter(cover => {
            // Check if explosion circle overlaps with cover rectangle
            const closestX = Math.max(cover.x, Math.min(x, cover.x + cover.width));
            const closestY = Math.max(cover.y, Math.min(y, cover.y + cover.height));
            const distance = Math.sqrt(
                Math.pow(x - closestX, 2) + 
                Math.pow(y - closestY, 2)
            );
            
            if (distance < radius) {
                // Cover is hit - for now we destroy it completely
                // Could implement partial damage here
                return false;
            }
            return true;
        });
    }

    hitPlayer(playerId, damage, attackerId) {
        const player = this.players.get(playerId);
        const attacker = this.players.get(attackerId);
        if (!player) return;

        // Apply shield first
        let actualDamage = damage;
        if (player.shield > 0) {
            const absorbed = Math.min(actualDamage, player.shield);
            player.shield -= absorbed;
            actualDamage -= absorbed;
        }

        player.health -= actualDamage;
        player.health = Math.max(0, player.health);
        
        // Award points to attacker
        if (attacker && attackerId !== playerId) {
            attacker.points += actualDamage;
        }

        // Send hit notification with updated points
        this.broadcast({
            type: 'playerHit',
            playerId: playerId,
            attackerId: attackerId,
            health: player.health,
            damage: actualDamage,
            attackerPoints: attacker ? attacker.points : 0
        });

        // Check for game over
        if (player.health <= 0) {
            this.endGame(attackerId);
        }
    }

    endGame(winnerId) {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
        
        this.broadcast({
            type: 'gameOver',
            winner: winnerId,
            finalState: {
                players: Object.fromEntries(
                    Array.from(this.players.entries()).map(([id, p]) => [
                        id,
                        {
                            name: p.name,
                            health: p.health,
                            points: p.points
                        }
                    ])
                )
            }
        });
        
        this.gameState.started = false;
    }

    checkProjectileCoverCollision(projectile, cover) {
        return projectile.x >= cover.x && 
               projectile.x <= cover.x + cover.width &&
               projectile.y >= cover.y && 
               projectile.y <= cover.y + cover.height;
    }

    checkProjectilePlayerCollision(projectile, player) {
        const distance = Math.sqrt(
            Math.pow(projectile.x - player.x, 2) + 
            Math.pow(projectile.y - player.y, 2)
        );
        return distance <= gameConfig.player.size / 2 + gameConfig.projectile.size;
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
                        currentRoom.handlePlayerShoot(playerId, data.targetX, data.targetY);
                    }
                    break;

                case 'usePowerup':
                    if (currentRoom && currentRoom.gameState.started) {
                        const result = currentRoom.handlePowerup(playerId, data.powerup);
                        if (!result.success && result.error) {
                            ws.send(JSON.stringify({ 
                                type: 'error', 
                                message: result.error 
                            }));
                        }
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
                if (remainingPlayer) {
                    currentRoom.endGame(remainingPlayer);
                }
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
