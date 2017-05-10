// Room brain: processes tasks from room and requests from worker body
// import {tasks} from '../maps/map_tasks';

import {Task} from "../tasks/Task";
import profiler = require('../lib/screeps-profiler');
import {taskPickup} from "../tasks/task_pickup";
import {taskRecharge} from "../tasks/task_recharge";
import {taskSupply} from "../tasks/task_supply";
import {taskRepair} from "../tasks/task_repair";
import {taskBuild} from "../tasks/task_build";
import {taskFortify} from "../tasks/task_fortify";
import {taskUpgrade} from "../tasks/task_upgrade";
import {roleWorker} from "../roles/role_worker";
import {roleHauler} from "../roles/role_hauler";
import {roleMiner} from "../roles/role_miner";
import {roleLinker} from "../roles/role_linker";
import {roleMineralSupplier} from "../roles/role_mineralSupplier";
import {roleSupplier} from "../roles/role_supplier";
import {roleUpgrader} from "../roles/role_upgrader";

export class RoomBrain {
    name: string;
    room: Room;
    spawn: StructureSpawn;
    incubating: boolean;
    settings: any;
    incubatingSettings: any;
    override: any;
    taskPriorities: string[];
    taskToExecute: { [taskType: string]: string };
    assignmentRoles: { [role: string]: string[] };
    assignmentConditions: { [taskType: string]: Function };

    constructor(roomName: string) {
        this.name = roomName;
        this.room = Game.rooms[roomName];
        this.spawn = _.filter(this.room.spawns, spawn => !spawn.spawning)[0];
        this.incubating = (_.filter(this.room.flags, flagCodes.territory.claimAndIncubate.filter).length > 0);
        // Settings shared across all rooms
        this.settings = {
            fortifyLevel: 1e+6, // fortify wall HP
            workerPatternRepetitionLimit: 30, // maximum number of body repetitions for workers
            maxWorkersPerRoom: 1, // maximum number of workers to spawn per room based on number of required jobs
            incubationWorkersToSend: 3, // number of big workers to send to incubate a room
            supplierPatternRepetitionLimit: 4, // maximum number of body repetitions for suppliers
            haulerPatternRepetitionLimit: 7, // maximum number of body repetitions for haulers
            remoteHaulerPatternRepetitionLimit: 8, // maximum number of body repetitions for haulers
            minersPerSource: 1, // number of miners to assign to a source
            storageBuffer: { // creeps of a given role can't withdraw from (or not deposit to) storage until this level
                linker: 75000, // linker must deposit to storage below this amount
                worker: 50000,
                upgrader: 75000,
                default: 0,
            },
            unloadStorageBuffer: 750000, // start sending energy to other rooms past this amount
            reserveBuffer: 3000, // colony rooms to this amount
            maxAssistLifetimePercentage: 0.1 // assist in spawn operations up to (creep.lifetime * this amount) distance
        };
        if (this.room.controller) {
            this.settings.fortifyLevel = Math.min(Math.pow(10, Math.max(this.room.controller.level, 3)), 1e+6);
        }
        // Settings for new rooms that are being incubated
        this.incubatingSettings = {
            fortifyLevel: 1e+4, // fortify all walls/ramparts to this level
            workerPatternRepetitionLimit: 10, // maximum number of body repetitions for workers
            maxWorkersPerRoom: 3, // maximum number of workers to spawn per room based on number of required jobs
            supplierPatternRepetitionLimit: 4, // maximum number of body repetitions for suppliers
            haulerPatternRepetitionLimit: 7, // maximum number of body repetitions for haulers
            remoteHaulerPatternRepetitionLimit: 8, // maximum number of body repetitions for haulers
            minersPerSource: 1, // number of miners to assign to a source
            storageBuffer: { // creeps of a given role can't withdraw from storage until this level
                worker: 1000,
                upgrader: 5000,
                default: 0,
            },
            reserveBuffer: 3000 // colony rooms to this amount
        };
        if (this.incubating) {
            this.settings = this.incubatingSettings; // overwrite settings for incubating rooms
        }
        // Settings to override this.settings for a particular room
        this.override = {
            workersPerRoom: { // custom number of workers per room
                // "W18N88": 2,
                // "W19N88": 5,
            },
            fortifyLevel: {
                // "W18N88": 2e+6
            }, // fortify all walls/ramparts to these levels in these rooms
        };

        // Task priorities - the actual priority the tasks are given. Everything else depends on this order
        this.taskPriorities = [
            'supplyTowers',
            'supply',
            'pickup',
            'collect',
            'repair',
            'build',
            'buildRoads',
            'fortify',
            'upgrade',
        ];
        // Tasks to execute for each prioritized task
        this.taskToExecute = {
            'pickup': 'pickup',
            'collect': 'recharge',
            'supplyTowers': 'supply',
            'supply': 'supply',
            'repair': 'repair',
            'build': 'build',
            'buildRoads': 'build',
            'fortify': 'fortify',
            'upgrade': 'upgrade',
        };
        // Task role conditions
        this.assignmentRoles = {
            'pickup': [], // ['supplier', 'hauler'],
            'collect': ['hauler'],
            'supplyTowers': ['supplier', 'hauler'],
            'supply': ['supplier', 'hauler'],
            'repair': ['worker', 'miner', 'guard'],
            'build': ['worker', 'miner'],
            'buildRoads': ['worker', 'guard'],
            'fortify': ['worker'],
            'upgrade': ['worker', 'upgrader'],
        };
        if (this.room.controller && this.room.controller.level == 8) { // workers shouldn't upgrade at GCL 8; only upgraders
            this.assignmentRoles['upgrade'] = ['upgrader'];
        }
        // Task assignment conditions
        this.assignmentConditions = {
            'pickup': (creep: Creep) => creep.getActiveBodyparts(CARRY) > 0 &&
                                        creep.carry.energy < creep.carryCapacity,
            'collect': (creep: Creep) => creep.getActiveBodyparts(CARRY) > 0 &&
                                         creep.carry.energy < creep.carryCapacity,
            'supplyTowers': (creep: Creep) => creep.getActiveBodyparts(CARRY) > 0 && creep.carry.energy > 0,
            'supply': (creep: Creep) => creep.getActiveBodyparts(CARRY) > 0 && creep.carry.energy > 0,
            'repair': (creep: Creep) => creep.getActiveBodyparts(WORK) > 0 && creep.carry.energy > 0,
            'build': (creep: Creep) => creep.getActiveBodyparts(WORK) > 0 && creep.carry.energy > 0,
            'buildRoads': (creep: Creep) => creep.getActiveBodyparts(WORK) > 0 && creep.carry.energy > 0,
            'fortify': (creep: Creep) => creep.getActiveBodyparts(WORK) > 0 && creep.carry.energy > 0,
            'upgrade': (creep: Creep) => creep.getActiveBodyparts(WORK) > 0 && creep.carry.energy > 0,
        };
    }

    get memory() {
        if (!Memory.roomBrain[this.name]) {
            Memory.roomBrain[this.name] = {};
        }
        return Memory.roomBrain[this.name];
    }

    // get localSpawnQueue() {
    //     if (!this.memory.spawnQueue) {
    //         this.memory.spawnQueue = {};
    //     }
    //     return this.memory.spawnQueue;
    // }
    //
    // get globalSpawnQueue() {
    //     if (!Memory.globalSpawnQueue) {
    //         Memory.globalSpawnQueue = {};
    //     }
    //     return Memory.globalSpawnQueue;
    // }

    log(message: string) {
        console.log(this.name + '_Brain: "' + message + '"');
    }


    // Creep task assignment ===========================================================================================

    getTasks(taskType: string): Task[] {
        var targets: RoomObject[] = [];
        var tasks: Task[] = [];
        switch (taskType) {
            case 'pickup': // Pick up energy
                targets = this.room.find(FIND_DROPPED_ENERGY, {
                    filter: (drop: Resource) => drop.amount > 100,
                }) as Resource[];
                tasks = _.map(targets, (target: Resource) => new taskPickup(target));
                break;
            case 'collect': // Collect from containers
                targets = _.filter(this.room.containers, container => container.store[RESOURCE_ENERGY] > 1000);
                tasks = _.map(targets, (target: Container) => new taskRecharge(target));
                break;
            case 'supplyTowers': // Find towers in need of energy
                targets = _.filter(this.room.towers, tower => tower.energy < tower.energyCapacity);
                tasks = _.map(targets, (target: Tower) => new taskSupply(target));
                break;
            case 'supply': // Find structures in need of energy
                targets = _.filter(this.room.sinks, structure => structure.energy < structure.energyCapacity);
                tasks = _.map(targets, (target: Sink) => new taskSupply(target));
                break;
            case 'repair': // Repair structures
                targets = _.filter(this.room.repairables,
                                   s => s.hits < s.hitsMax &&
                                        (s.structureType != STRUCTURE_CONTAINER || s.hits < 0.7 * s.hitsMax) &&
                                        (s.structureType != STRUCTURE_ROAD || s.hits < 0.7 * s.hitsMax));
                tasks = _.map(targets, (target: Structure) => new taskRepair(target));
                break;
            case 'build': // Build construction jobs
                targets = this.room.structureSites;
                tasks = _.map(targets, (target: ConstructionSite) => new taskBuild(target));
                break;
            case 'buildRoads': // Build construction jobs
                targets = this.room.roadSites;
                tasks = _.map(targets, (target: ConstructionSite) => new taskBuild(target));
                break;
            case 'fortify': // Fortify walls
                var fortifyLevel = this.settings.fortifyLevel; // global fortify level
                if (this.override.fortifyLevel[this.room.name]) {
                    fortifyLevel = this.override.fortifyLevel[this.room.name]; // override for certain rooms
                }
                //noinspection JSReferencingMutableVariableFromClosure
                targets = _.filter(this.room.barriers, s => s.hits < fortifyLevel);
                tasks = _.map(targets, (target: StructureWall | Rampart) => new taskFortify(target));
                break;
            case 'upgrade': // Upgrade controller
                if (this.room.controller && this.room.controller.my) {
                    targets = [this.room.controller];
                    tasks = _.map(targets, (target: Controller) => new taskUpgrade(target));
                }
                break;
        }
        return tasks;
    }

    getMostUrgentTask(tasksToGet: string[]): Task[] {
        for (let taskType of tasksToGet) {
            var tasks = this.getTasks(taskType);
            // ignore targets that are already targeted by too many creeps
            tasks = _.filter(tasks, task => task.target.targetedBy.length < task.maxPerTarget);
            if (tasks.length > 0) { // return on the first instance of a target being found
                return tasks;
            }
        }
        return [];
    }

    assignTask(creep: Creep): string {
        var applicableTasks: string[] = _.filter(this.taskPriorities,
                                                 task => this.assignmentRoles[task].includes(creep.memory.role) &&
                                                         this.assignmentConditions[task](creep));
        var tasks = this.getMostUrgentTask(applicableTasks);
        // Assign the task
        if (tasks.length > 0) { // TODO: is this null check necessary?
            var task;
            if (tasks[0].name == 'fortify') {
                // fortification should target lowest HP barrier
                task = _.sortBy(tasks, (task: taskFortify) => task.target.hits)[0];
            } else {
                if (creep.room == this.room) {
                    task = _.sortBy(tasks, (task: Task) => creep.pos.getRangeTo(task.target))[0];
                    // task = creep.pos.findClosestByRange(targets);
                } else {
                    task = tasks[0];
                }
            }
            if (task) {
                return creep.assign(task);
            }
        }
        return "";
    }


    // Creep quantity and size requirements ============================================================================

    calculateWorkerRequirementsByEnergy(): number {
        // Calculate needed numbers of workers from an energetics standpoint
        var spawn = this.spawn;
        if (spawn) {
            if (this.override.workersPerRoom[this.name]) {
                return this.override.workersPerRoom[this.name]
            }
            var energy = this.room.energyCapacityAvailable;
            var workerBodyPattern = new roleWorker().settings.bodyPattern;
            var workerSize = Math.min(Math.floor(energy / spawn.cost(workerBodyPattern)),
                                      this.settings.workerPatternRepetitionLimit);
            var equilibriumEnergyPerTick = workerSize;
            if (this.room.storage == undefined) {
                equilibriumEnergyPerTick /= 1.5; // workers spend a lot of time walking around if there's not storage
            }
            var sourceEnergyPerTick = (3000 / 300) * this.room.sources.length;
            return Math.ceil(0.8 * sourceEnergyPerTick / equilibriumEnergyPerTick); // operate under capacity limit
        } else {
            return 0;
        }
    }

    calculateWorkerRequirementsByJobs(): number { // TODO: replace from number of jobs to total time of jobs
        // Calculate needed number of workers based on number of jobs present; used at >=RCL5
        // repair jobs - custom calculated; workers should spawn once several repairs are needed to roads
        var numRepairJobs = _.filter(this.room.repairables,
                                     s => s.hits < s.hitsMax &&
                                          (s.structureType != STRUCTURE_ROAD || s.hits < 0.5 * s.hitsMax)).length;
        // construction jobs
        var numConstructionJobs = this.getTasks('build').length + this.getTasks('buildRoads').length;
        // fortify jobs
        var numFortifyJobs = this.getTasks('fortify').length;
        var numJobs = numRepairJobs + numConstructionJobs + numFortifyJobs;
        if (numJobs == 0) {
            return 0;
        } else {
            var workerBodyPattern = new roleWorker().settings.bodyPattern;
            var workerSize = Math.min(Math.floor(this.room.energyCapacityAvailable / this.spawn.cost(workerBodyPattern)),
                                      this.settings.workerPatternRepetitionLimit);
            return Math.min(Math.ceil((2 / workerSize) * numJobs), this.settings.maxWorkersPerRoom);
        }
    }

    calculateHaulerSize(target: Source): number { // required hauler size to fully saturate a source given distance
        var haulerBodyPattern = new roleHauler().settings.bodyPattern;
        var tripLength; // total round-trip distance, assuming full speed
        tripLength = 2 * target.pathLengthToStorage;
        var carryPartsPerRepetition = _.filter(haulerBodyPattern, part => part == CARRY).length; // carry parts
        var energyPerTripPerRepetition = 50 * carryPartsPerRepetition; // energy per trip per repetition of body pattern
        var energyPerTickPerRepetition = energyPerTripPerRepetition / tripLength; // energy per tick per repetition
        var sourceEnergyPerTick = (3000 / 300);
        var sizeRequiredForEquilibrium = sourceEnergyPerTick / energyPerTickPerRepetition; // size a hauler needs to be
        return Math.ceil(1.1 * sizeRequiredForEquilibrium); // slightly overestimate
    }

    calculateHaulerRequirements(target: Source): [number, number] {
        // Calculate needed numbers of haulers for a source
        var spawn = this.spawn;
        if (spawn && this.room && this.room.storage) {
            if (target.linked && this.room.storage.linked) { // don't send haulers to linked sources
                return [0, 0];
            }
            var haulerBodyPattern = new roleHauler().settings.bodyPattern;
            var haulerSize = this.calculateHaulerSize(target); // calculate required hauler size
            var numHaulers = 1; // 1 hauler unless it's too large
            var maxHaulerSize = Math.min(Math.floor(this.room.energyCapacityAvailable / spawn.cost(haulerBodyPattern)),
                                         (50 / haulerBodyPattern.length));
            if (haulerSize > maxHaulerSize) { // if hauler is too big, adjust size to max and number accordingly
                numHaulers = haulerSize / maxHaulerSize; // amount needed
                haulerSize = Math.ceil(maxHaulerSize * (numHaulers / Math.ceil(numHaulers))); // chop off excess
                numHaulers = Math.ceil(numHaulers); // amount -> integer
            }
            return [haulerSize, numHaulers];
        } else {
            return [0, 0];
        }
    }

    calculateRemoteHaulingRequirements(): number {
        let miningFlags = _.filter(this.room.assignedFlags, flagCodes.industry.remoteMine.filter);
        let haulingNeeded = _.sum(_.map(miningFlags, flag => flag.haulingNeeded));
        return haulingNeeded * 1.2; // add a bit of excess to account for inefficiencies
    }


    // Core creep spawning operations ==================================================================================

    handleMiners(): protoCreep | void {
        if (!this.incubating) {
            var sources = this.room.sources;
            for (let source of sources) {
                // Check enough miners are supplied
                let assignedMiners = source.getAssignedCreepAmounts('miner');
                if (assignedMiners < this.settings.minersPerSource) {
                    return new roleMiner().create(this.spawn, {
                        assignment: source,
                        workRoom: this.room.name,
                        patternRepetitionLimit: 3,
                    });
                }
            }
        }
    }

    handleHaulers(): protoCreep | void {
        // Check enough haulers are supplied
        if (this.room.storage) { // haulers are only built once a room has storage
            // find all unlinked sources
            var sources = _.filter(this.room.sources, s => s.linked == false || this.room.storage!.linked == false);
            for (let source of sources) {
                // Check enough haulers are supplied if applicable
                let assignedHaulers = source.getAssignedCreepAmounts('hauler');
                var [haulerSize, numHaulers] = this.calculateHaulerRequirements(source);
                if (assignedHaulers < numHaulers) {
                    return new roleHauler().create(this.spawn, {
                        assignment: source,
                        workRoom: this.room.name,
                        patternRepetitionLimit: haulerSize,
                    });
                }
            }
        }
    }

    handleLinkers(): protoCreep | void {
        // Check enough haulers are supplied
        if (this.room.storage != undefined && this.room.storage.linked) { // linkers only for storage with links
            if (this.room.storage.getAssignedCreepAmounts('linker') < 1) {
                return new roleLinker().create(this.spawn, {
                    assignment: this.room.storage,
                    workRoom: this.room.name,
                    patternRepetitionLimit: 8,
                });
            }
        }
    }

    handleMineralSuppliers(): protoCreep | void {
        // Check enough haulers are supplied
        if (this.room.terminal != undefined && this.room.labs.length > 0) {
            if (this.room.terminal.getAssignedCreepAmounts('mineralSupplier') < 1) {
                return new roleMineralSupplier().create(this.spawn, {
                    assignment: this.room.terminal,
                    workRoom: this.room.name,
                    patternRepetitionLimit: 1,
                });
            }
        }
    }

    handleSuppliers(): protoCreep | void {
        // Handle suppliers
        var numSuppliers = this.room.controller!.getAssignedCreepAmounts('supplier');
        var numEnergySinks = this.room.sinks.length + this.room.towers.length;
        // var storageUnits = this.room.storageUnits;
        if (numEnergySinks > 1) { // if there's just a spawner in the room, like in RCL1 rooms
            var supplierLimit = 2; // there must always be at least one supplier in the room
            // if (_.filter(energySinks, s => s.energy < s.energyCapacity).length > 0) {
            //     supplierLimit += 1;
            // }
            var expensiveFlags = _.filter(this.room.assignedFlags, flag => flagCodes.millitary.filter(flag) ||
                                                                           flagCodes.destroy.filter(flag) ||
                                                                           flagCodes.industry.filter(flag) ||
                                                                           flagCodes.territory.filter(flag));
            supplierLimit += Math.floor(expensiveFlags.length / 10); // add more suppliers for cases of lots of flags // TODO: better metric
            let supplierSize;
            if (numSuppliers == 0) { // in case the room runs out of suppliers at low energy
                // supplierSize = Math.min(this.settings.supplierPatternRepetitionLimit,
                //                         this.room.energyAvailable / roles('supplier').bodyCost(
                //                             roles('supplier').settings.bodyPattern));
                supplierSize = 1;
                // this.log(supplierSize)
            } else {
                supplierSize = this.settings.supplierPatternRepetitionLimit;
            }
            if (numSuppliers < supplierLimit) {
                return new roleSupplier().create(this.spawn, {
                    assignment: this.room.controller!,
                    workRoom: this.room.name,
                    patternRepetitionLimit: supplierSize // this.settings.supplierPatternRepetitionLimit
                });
            }
        }
    }

    handleWorkers(): protoCreep | void {
        if (!this.incubating) { // don't make your own workers during incubation period, just keep existing ones alive
            var numWorkers = this.room.controller!.getAssignedCreepAmounts('worker');
            // Only spawn workers once containers are up
            var workerRequirements = 0;
            if (this.room.storage) {
                workerRequirements = this.calculateWorkerRequirementsByJobs(); // switch to worker/upgrader once storage
            } else {
                workerRequirements = this.calculateWorkerRequirementsByEnergy(); // no static upgraders prior to RCL4
            }
            if (numWorkers < workerRequirements && this.room.storageUnits.length > 0) {
                return new roleWorker().create(this.spawn, {
                    assignment: this.room.controller!,
                    workRoom: this.room.name,
                    patternRepetitionLimit: this.settings.workerPatternRepetitionLimit,
                });
            }
        }
    }

    handleUpgraders(): protoCreep | void {
        if (this.room.storage) { // room needs to have storage before upgraders happen
            var numUpgraders = this.room.controller!.getAssignedCreepAmounts('upgrader');
            var amountOver = Math.max(this.room.storage.store[RESOURCE_ENERGY]
                                      - this.settings.storageBuffer['upgrader'], 0);
            var upgraderSize = 1 + Math.floor(amountOver / 20000);
            if (this.room.controller!.level == 8) {
                upgraderSize = Math.min(upgraderSize, 3); // don't go above 15 work parts at RCL 8
            }
            let role = new roleUpgrader();
            var numUpgradersNeeded = Math.ceil(upgraderSize * role.bodyPatternCost /
                                               this.room.energyCapacityAvailable); // this causes a jump at 2 upgraders
            if (numUpgraders < numUpgradersNeeded) {
                return role.create(this.spawn, {
                    assignment: this.room.controller!,
                    workRoom: this.room.name,
                    patternRepetitionLimit: upgraderSize,
                });
            }
        }
    }


    // Inferred spawner operations =====================================================================================

    handleRemoteHaulers(): protoCreep | void {
        // Check enough haulers exist to satisfy all demand from associated rooms
        if (this.room.storage) { // haulers are only built once a room has storage
            let haulingNeeded = this.calculateRemoteHaulingRequirements();
            let haulingSupplied = _.sum(_.map(this.room.storage.getAssignedCreeps('hauler'), c => c.carryCapacity));
            if (haulingSupplied < haulingNeeded) {
                return new roleHauler().create(this.spawn, {
                    assignment: this.room.storage, // remote haulers are assigned to storage
                    workRoom: this.room.name,
                    patternRepetitionLimit: Infinity,
                });
            }
        }
    }

    // Spawner operations ==============================================================================================
    // TODO: Move to Brain_Spawn.js

    handleCoreSpawnOperations() { // core operations needed to keep a room running; all creeps target things in room
        var handleResponse;
        // Domestic operations
        var prioritizedDomesticOperations = [
            () => this.handleSuppliers(), // don't move this from top
            () => this.handleLinkers(),
            () => this.handleMineralSuppliers(),
            () => this.handleMiners(),
            () => this.handleHaulers(),
            () => this.handleWorkers(),
            () => this.handleUpgraders(),
        ];

        // Handle domestic operations
        for (let handler of prioritizedDomesticOperations) {
            handleResponse = handler();
            if (handleResponse != null) {
                return handleResponse;
            }
        }

        // Renew expensive creeps if needed
        let creepsNeedingRenewal = this.spawn.pos.findInRange(FIND_MY_CREEPS, 1, {
            filter: (creep: Creep) => creep.memory.data.renewMe && creep.ticksToLive < 500,
        });
        if (creepsNeedingRenewal.length > 0) {
            return 'renewing (renew call is done through task_getRenewed.work)';
        }

        return null;
    }

    handleIncubationSpawnOperations() { // operations to start up a new room quickly by sending renewable large creeps
        var incubateFlags = _.filter(this.room.assignedFlags,
                                     flag => flagCodes.territory.claimAndIncubate.filter(flag) &&
                                             flag.room && flag.room.my);
        incubateFlags = _.sortBy(incubateFlags, flag => flag.pathLengthToAssignedRoomStorage);
        for (let flag of incubateFlags) {
            // spawn miner creeps
            let flagRoom = flag.room!;
            let minerBehavior = new roleMiner();
            for (let source of flagRoom.sources) {
                if (source.getAssignedCreepAmounts('miner') < this.settings.minersPerSource) {
                    let creep = minerBehavior.create(this.spawn, {
                        assignment: source,
                        workRoom: flagRoom.name,
                        patternRepetitionLimit: 3
                    });
                    creep.memory.data.renewMe = true;
                    return creep;
                }
            }
            // spawn worker creeps
            let workerBehavior = new roleWorker();
            let assignedWorkers = flagRoom.controller!.getAssignedCreeps('worker');
            let incubationWorkers = _.filter(assignedWorkers,
                                             c => c.body.length >= workerBehavior.settings.bodyPattern.length *
                                                                   this.settings.workerPatternRepetitionLimit);
            if (incubationWorkers.length < this.settings.incubationWorkersToSend) {
                let creep = workerBehavior.create(this.spawn, {
                    assignment: flagRoom.controller!,
                    workRoom: flagRoom.name,
                    patternRepetitionLimit: this.settings.workerPatternRepetitionLimit,
                });
                creep.memory.data.renewMe = true;
                return creep;
            }
        }
        return null;
    }

    handleAssignedSpawnOperations() { // operations associated with an assigned flags, such as spawning millitary creeps
        var handleResponse;
        // Flag operations
        let flags = this.room.assignedFlags; // TODO: make this a lookup table
        var prioritizedFlagOperations = [
            _.filter(flags, flagCodes.vision.stationary.filter),
            _.filter(flags, flagCodes.territory.claimAndIncubate.filter),
            _.filter(flags, flagCodes.millitary.guard.filter),
            _.filter(flags, flagCodes.territory.colony.filter),

            // _.filter(flags, flagCodes.rally.healPoint.filter),
            _.filter(flags, flagCodes.millitary.destroyer.filter),
            _.filter(flags, flagCodes.millitary.sieger.filter),

            _.filter(flags, flagCodes.industry.remoteMine.filter),
        ];

        // Handle actions associated with assigned flags
        for (let flagPriority of prioritizedFlagOperations) {
            var flagsSortedByRange = _.sortBy(flagPriority, flag => flag.pathLengthToAssignedRoomStorage);
            for (let flag of flagsSortedByRange) {
                handleResponse = flag.action(this);
                if (handleResponse != null) {
                    return handleResponse;
                }
            }
        }
        return null;
    }


    handleInferredSpawnOperations() { // spawn operations handled locally but inferred by assigned operations
        var handleResponse;
        var prioritizedOperations = [
            () => this.handleRemoteHaulers(),
        ];

        for (let handler of prioritizedOperations) {
            handleResponse = handler();
            if (handleResponse != null) {
                return handleResponse;
            }
        }

        return null;
    }

    assistAssignedSpawnOperations() { // help out other rooms with their assigned operations
        // other rooms sorted by increasing distance
        let myRooms = _.sortBy(_.filter(Game.rooms, room => room.my), room => this.spawn.pathLengthTo(room.spawns[0]));
        for (let i in myRooms) {
            let brain = myRooms[i].brain;
            let distance = this.spawn.pathLengthTo(myRooms[i].spawns[0]);
            if (!brain.spawn) {
                brain.spawn = this.spawn;
                let creepToBuild = brain.handleAssignedSpawnOperations();
                if (creepToBuild != null) {
                    let lifetime;
                    if (_.map(creepToBuild.body, (part: BodyPartDefinition) => part.type).includes(CLAIM)) {
                        lifetime = 500;
                    } else {
                        lifetime = 1500;
                    }
                    if (distance < this.settings.maxAssistLifetimePercentage * lifetime) {
                        // build the creep if it's not too far away
                        return creepToBuild;
                    }
                }
            }
        }
        return null;
    }

    handleSpawnOperations() {
        if (this.spawn && !this.spawn.spawning) { // only spawn if you have an available spawner
            // figure out what to spawn next
            var creep;
            var prioritizedSpawnOperations = [
                () => this.handleCoreSpawnOperations(),
                () => this.handleIncubationSpawnOperations(),
                () => this.handleAssignedSpawnOperations(),
                () => this.handleInferredSpawnOperations(),
                // () => this.assistAssignedSpawnOperations()
            ];
            // Handle all operations
            for (let spawnThis of prioritizedSpawnOperations) {
                creep = spawnThis();
                if (creep != null) {
                    return this.spawn.createCreep(creep.body, creep.name, creep.memory);
                }
            }
            return null;
        } else {
            return null;
        }
    }


    // Market operations ===============================================================================================

    handleTerminalOperations() {
        if (this.room.terminal != undefined) {
            this.room.terminal.brain.run();
        }
    }


    // Safe mode condition =============================================================================================

    handleSafeMode() { // TODO: make this better, defcon system
        // var criticalBarriers = this.room.find(FIND_STRUCTURES, {
        //     filter: (s) => (s.structureType == STRUCTURE_WALL || s.structureType == STRUCTURE_RAMPART) &&
        //                    s.hits < 5000
        // });
        let criticalBarriers = _.filter(this.room.barriers, s => s.hits < 5000);
        if (criticalBarriers.length > 0 && this.room.hostiles.length > 0 && !this.incubating) {
            // no safe mode for incubating rooms (?)
            this.room.controller!.activateSafeMode();
        }
    }

    // List of things executed each tick; only run for rooms that are owned
    run() {
        // this.handleSafeMode();
        this.handleSpawnOperations(); // build creeps as needed
        this.handleTerminalOperations(); // repleneish needed resources
    }
}

// const profiler = require('screeps-profiler');
profiler.registerClass(RoomBrain, 'RoomBrain');
