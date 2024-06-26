const express = require('express');
const app = express();
const bodyParser = require('body-parser');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded());

const Sequelize = require('sequelize');
const {MongoClient} = require('mongodb');
const {v4: uuidv4} = require('uuid');
const {QueryTypes} = require("sequelize");
const {Engine} = require('json-rules-engine');
const axios = require('axios');

let startOfDay = new Date();
let startOfWeek = new Date();

app.listen(4000, () => {
    console.log('Server has started on PORT 4000');
    // Initially set the startOfDay and startOfWeek
    // resetStartOfDay();
    // resetStartOfWeek();
    //
    // // Schedule the startOfDay to reset every 2 minutes
    // setInterval(resetStartOfDay, 2 * 60 * 1000); // 2 minutes in milliseconds
    //
    // // Schedule the startOfWeek to reset every 3 minutes
    // setInterval(resetStartOfWeek, 3 * 60 * 1000); // 3 minutes in milliseconds
});

function taskConfigCriteriaValidation(dbTaskBus, dbTask, createdAtLocal, todayAtMidnight, lastSundayAtMidnight) {
    return !dbTaskBus.length
        ||
        dbTask[0].is_recurring === true
        ||
        (dbTaskBus.length && dbTask[0].type === 'daily' && createdAtLocal < todayAtMidnight)
        ||
        (dbTaskBus.length && dbTask[0].type === 'weekly' && createdAtLocal < lastSundayAtMidnight);
}

app.post('/test-run', async (req, res) => {
    let {eventId, projectId, parameterIds, userId, paramDetails, levelSystemDetails, collectionName} = req.body; // You should replace this with the actual way to extract these values from the event
    let originalParamDetails = {...paramDetails};

    const sequelize = new Sequelize(
        'dirtcube-specterapp-dev',
        'admin',
        'Dirtcube2019',
        {
            host: '13.232.44.32',
            dialect: 'postgres',
            port: 5432,
            logging: false,
        }
    );

    // Set up Mongoose connection
    const mongoURI = 'mongodb://admin:Dirtcube2019@13.232.44.32:27017/dirtcube-specterapp-dev?retryWrites=true&w=majority'; // Replace placeholders
    const client = new MongoClient(mongoURI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });


    try {
        await client.connect();
        const db = client.db();

        const taskParametersCollection = db.collection('taskparameters'); // Use your collection name

        const levelMatchArray = levelSystemDetails.length ? levelSystemDetails.map(detail => ({
            "levelSystemLevelDetails": {
                "$elemMatch": {
                    "levelSystemId": detail.levelSystemId,
                    "level": {$lte: detail.level}
                }
            }
        })) : [];

        const orQuery = [];

        if (levelMatchArray.length) {
            orQuery.push({$and: levelMatchArray},
                {levelSystemLevelDetails: {$size: 0}},
                {levelSystemLevelDetails: {$exists: false}})
        } else {
            orQuery.push({levelSystemLevelDetails: {$size: 0}},
                {levelSystemLevelDetails: {$exists: false}})
        }

        let tasks;
        if (parameterIds.length) {
            tasks = await taskParametersCollection.find({
                eventId: eventId, // Use the retrieved event's ID
                projectId: projectId, // Use the provided projectId
                $or: orQuery,
                // "parameters": {
                //     $elemMatch: {
                //         "parameterId": {
                //             $in: parameterIds
                //         }
                //     }
                // },
            }).toArray();
        }

        if (!parameterIds.length) {
            tasks = await taskParametersCollection.find({
                eventId: eventId, // Use the retrieved event's ID
                projectId: projectId, // Use the provided projectId
                $or: orQuery,
                "parameters": null,
            }).toArray();
        }

        for (let task of tasks) {
            try {
                const utsc = db.collection('usertaskstatus');
                let taskValidationInit = false;

                if (!task.parameters || !task.parameters.length) {
                    const dbTask = await sequelize.query(`select * from tasks where id=:taskId`, {
                        replacements: {
                            taskId: task.taskId
                        },
                        raw: true,
                        nest: true
                    });

                    if (dbTask.length && dbTask[0].task_group_id && dbTask[0].sorting_order > 1 &&
                        dbTask[0].status === 'in progress') {
                        const currentSortingOrder = dbTask[0].sorting_order;

                        const dbTaskLessThanCurrentSortingOrder = await sequelize.query(`select id from tasks where task_group_id=:taskGroupId and sorting_order < :sortingOrder;`, {
                            type: QueryTypes.SELECT,
                            replacements: {
                                taskGroupId: dbTask[0].task_group_id,
                                sortingOrder: currentSortingOrder
                            }
                        });
                        const ids = dbTaskLessThanCurrentSortingOrder.map(task => `'${task.id}'`).join(', ');
                        const dbTaskBusWithTaskIds = await sequelize.query(`select id from task_bus where task_id in (${ids}) and user_id=:userId and created_at >=:currentStartDate and created_at<=:currentEndDate;`, {
                            type: QueryTypes.SELECT,
                            replacements: {
                                userId: userId,
                                currentStartDate: dbTask[0].current_start_date,
                                currentEndDate: dbTask[0].current_end_date ? dbTask[0].current_end_date : new Date().toISOString()
                            }
                        });

                        if (currentSortingOrder > 1 && currentSortingOrder - 1 > dbTaskBusWithTaskIds.length) {
                            continue;
                        }
                    }
                    if (dbTask.length && dbTask[0].is_available_for_current_cycle === true &&
                        dbTask[0].status === 'in progress') {
                        const dbTaskBus = await sequelize.query(`select * from task_bus where task_id=:taskId and user_id=:userId and created_at >=:currentStartDate and created_at<=:currentEndDate order by created_at desc limit 1;`, {
                            replacements: {
                                taskId: task.taskId,
                                userId: userId,
                                currentStartDate: dbTask[0].current_start_date,
                                currentEndDate: dbTask[0].current_end_date ? dbTask[0].current_end_date : new Date().toISOString()
                            },
                            raw: true,
                            nest: true
                        });

                        if (!dbTaskBus.length) {
                            const taskStatus = dbTask[0].reward_claim === 'automatic' ? 'reward_claimed' : 'completed';
                            await sequelize.query(`insert into task_bus(id, status, meta, project_id, user_id, task_id, task_group_id, active, archive, created_at, updated_at)
values (uuid_generate_v4(), '${taskStatus}', null, '${projectId}', '${userId}', '${task.taskId}', null, true, false, now(), now())`, {
                                type: QueryTypes.INSERT,
                                nest: true
                            });

                            await utsc.insertOne({
                                taskId: task.taskId,
                                projectId: projectId,
                                userId: userId,
                                status: 'succeed'
                            });

                            await axios.post('http://localhost:3000/v1/task/grantReward', {
                                userId: userId,
                                eventId: eventId,
                                taskId: task.taskId
                            });
                        }

                        if (task.taskGroupId) {
                            const noOfConfigTasks = await sequelize.query(`select id from tasks where task_group_id=:taskGroupId and archive=:archive and is_available_for_current_cycle=:isAvailableForCurrentCycle;`, {
                                type: QueryTypes.SELECT,
                                replacements: {
                                    taskGroupId: task.taskGroupId,
                                    archive: false,
                                    isAvailableForCurrentCycle: true
                                },
                                nest: true,
                                raw: true
                            });

                            const ids = noOfConfigTasks.map(task => `'${task.id}'`).join(', ');
                            const noOfTasksCompleted = await sequelize.query(`select count(*) from task_bus where task_id in (${ids}) and user_id='${userId}';`, {type: QueryTypes.SELECT});
                            if (noOfTasksCompleted[0].count >= noOfConfigTasks.length) {
                                const dbTaskGroup = await sequelize.query(`select * from task_groups where id=:taskGroupId`, {
                                    replacements: {
                                        taskGroupId: task.taskGroupId
                                    },
                                    raw: true,
                                    nest: true
                                });

                                if (dbTaskGroup[0].status === 'in progress') {
                                    const dbTaskGroupTaskBus = await sequelize.query(`select * from task_bus where task_group_id=:taskGroupId`, {
                                        replacements: {
                                            taskGroupId: task.taskGroupId
                                        },
                                        raw: true,
                                        nest: true
                                    })

                                    if (!dbTaskGroupTaskBus.length || dbTaskGroup[0].is_recurring === true) {
                                        const taskBusStatus = dbTaskGroup[0].reward_claim === 'automatic' ? 'reward_claimed' : 'completed';

                                        // Task group is completed
                                        await sequelize.query(`insert into task_bus(id, status, meta, project_id, user_id, task_id, task_group_id, active, archive, created_at, updated_at)
                     values (uuid_generate_v4(), '${taskBusStatus}', null, '${projectId}', '${userId}', null, '${task.taskGroupId}', true, false, now(), now())`, {
                                            type: QueryTypes.INSERT,
                                            nest: true
                                        });

                                        await axios.post('http://localhost:3000/v1/task/grantReward', {
                                            userId: userId,
                                            eventId: eventId,
                                            taskGroupId: task.taskGroupId
                                        });
                                    }
                                }
                            }
                        }
                    }
                }

                if (task.parameters && task.parameters.length) {
                    let shouldEvaluate = true
                    const dbTask = await sequelize.query(`select * from tasks where id=:taskId`, {
                        replacements: {
                            taskId: task.taskId
                        },
                        raw: true,
                        nest: true
                    });

                    if (!task.isRecurring) {
                        const dbTaskBusWithUserId = await sequelize.query(`select * from task_bus where task_id=:taskId and user_id=:userId and created_at >=:currentStartDate and created_at<=:currentEndDate;`, {
                            replacements: {
                                taskId: task.taskId,
                                userId: userId,
                                currentStartDate: dbTask[0].current_start_date,
                                currentEndDate: dbTask[0].current_end_date ? dbTask[0].current_end_date : new Date().toISOString()
                            },
                            type: QueryTypes.SELECT
                        });

                        if (dbTaskBusWithUserId.length) {
                            shouldEvaluate = false
                            continue;
                        }
                    }

                    for (let param of task.parameters) {
                        // Task is one time
                        if (!task.isRecurring) {
                            if (dbTask.length && dbTask[0].status !== 'in progress') {
                                shouldEvaluate = false;
                            }

                            if (dbTask.length
                                && dbTask[0].is_available_for_current_cycle === true
                                && dbTask[0].status === 'in progress') {

                                if (dbTask[0].task_group_id && dbTask[0].sorting_order > 1 && dbTask[0].type === 'static') {
                                    const currentSortingOrder = dbTask[0].sorting_order;

                                    const dbTaskLessThanCurrentSortingOrder = await sequelize.query(`select id from tasks where task_group_id=:taskGroupId and sorting_order < :sortingOrder;`, {
                                        type: QueryTypes.SELECT,
                                        replacements: {
                                            taskGroupId: dbTask[0].task_group_id,
                                            sortingOrder: currentSortingOrder
                                        }
                                    });
                                    const ids = dbTaskLessThanCurrentSortingOrder.map(task => `'${task.id}'`).join(', ');
                                    const dbTaskBusWithTaskIds = await sequelize.query(`select id from task_bus where task_id in (${ids}) and user_id=:userId and created_at >=:currentStartDate and created_at<=:currentEndDate;`, {
                                        type: QueryTypes.SELECT,
                                        replacements: {
                                            userId: userId,
                                            currentStartDate: dbTask[0].current_start_date,
                                            currentEndDate: dbTask[0].current_end_date ? dbTask[0].current_end_date : new Date().toISOString()
                                        },
                                    });

                                    if (currentSortingOrder > 1 && currentSortingOrder - 1 > dbTaskBusWithTaskIds.length) {
                                        shouldEvaluate = false;
                                        continue;
                                    }
                                }

                                let clientDefinedCustomEventId;
                                if (dbTask[0].custom_event_id) {
                                    const dbCustomEvent = await sequelize.query(`select * from app_events_custom where id=:customEventId`, {
                                        replacements: {
                                            customEventId: dbTask[0].custom_event_id
                                        },
                                        type: QueryTypes.SELECT,
                                        nest: true,
                                        raw: true
                                    });

                                    if (dbCustomEvent[0]) {
                                        clientDefinedCustomEventId = dbCustomEvent[0].event_id
                                    }
                                }
                                if (param.incrementalType === 'cumulative') {
                                    taskValidationInit = true
                                    const userUpdateWalletCollection = db.collection(collectionName);
                                    const pipeline = getAggregateQuery({
                                        parameters: task.parameters,
                                        userId,
                                        limit: param.noOfRecords || null,
                                        startDate: param.noOfRecords === 'all' ? null : dbTask[0].current_start_date ? new Date(dbTask[0].current_start_date) : null,
                                        endDate: dbTask[0].current_end_date ? new Date(dbTask[0].current_end_date) : null,
                                        businessLogic: task.businessLogic,
                                        customEventId: clientDefinedCustomEventId
                                    });
                                    const result = await userUpdateWalletCollection.aggregate(pipeline).toArray();

                                    if (result.length) {
                                        paramDetails[param.parameterName] = result[0][param.parameterName + "Sum"]
                                    }
                                }
                            }
                        }

                        // Task is everytime
                        if (task.isRecurring) {
                            // const dbDoc = await utsc.find({userId: userId, taskId: task.taskId}).toArray();
                            // if (dbDoc) {
                            //     console.log('Doc found');
                            // }

                            const userUpdateWalletCollection = db.collection(collectionName);

                            const dbDoc = await userUpdateWalletCollection.find({userId: userId}).toArray();

                            if (param.incrementalType === 'cumulative') {
                                taskValidationInit = true
                                if (param.noOfRecords) {
                                    const modResult = dbDoc.length ? dbDoc.length % param.noOfRecords : param.noOfRecords;
                                    param.noOfRecords = modResult ? modResult : param.noOfRecords
                                }

                                if (!param.noOfRecords && param.startTime) {
                                    const dbTaskBus = await sequelize.query(`select * from task_bus where task_id='${task.taskId}' and user_id='${userId}' order by created_at desc limit 1;`, {
                                        type: QueryTypes.SELECT,
                                        nest: true,
                                        raw: true
                                    });

                                    if (dbTaskBus && dbTaskBus.length) {
                                        param.startTime = dbTaskBus[0].created_at
                                    }
                                }

                                const dbTask = await sequelize.query(`select * from tasks where id=:taskId`, {
                                    replacements: {
                                        taskId: task.taskId
                                    },
                                    raw: true,
                                    nest: true
                                });

                                if (dbTask.length && dbTask[0].status !== 'in progress') {
                                    shouldEvaluate = false;
                                }

                                if (dbTask[0].task_group_id && dbTask[0].sorting_order > 1 && dbTask[0].type === 'static' && dbTask[0].status === 'in progress') {
                                    const currentSortingOrder = dbTask[0].sorting_order;

                                    const dbTaskLessThanCurrentSortingOrder = await sequelize.query(`select id from tasks where task_group_id=:taskGroupId and sorting_order < :sortingOrder;`, {
                                        type: QueryTypes.SELECT,
                                        replacements: {
                                            taskGroupId: dbTask[0].task_group_id,
                                            sortingOrder: currentSortingOrder
                                        }
                                    });
                                    const ids = dbTaskLessThanCurrentSortingOrder.map(task => `'${task.id}'`).join(', ');
                                    const dbTaskBusWithTaskIds = await sequelize.query(`select id from task_bus where task_id in (${ids}) and user_id=:userId and created_at >=:currentStartDate and created_at<=:currentEndDate;`, {
                                        type: QueryTypes.SELECT,
                                        replacements: {
                                            userId: userId,
                                            currentStartDate: dbTask[0].current_start_date,
                                            currentEndDate: dbTask[0].current_end_date ? dbTask[0].current_end_date : new Date().toISOString()
                                        }
                                    });

                                    if (currentSortingOrder > 1 && currentSortingOrder - 1 > dbTaskBusWithTaskIds.length) {
                                        continue;
                                    }
                                }

                                let clientDefinedCustomEventId;
                                if (dbTask[0].custom_event_id) {
                                    const dbCustomEvent = await sequelize.query(`select * from app_events_custom where id=:customEventId`, {
                                        replacements: {
                                            customEventId: dbTask[0].custom_event_id
                                        },
                                        type: QueryTypes.SELECT,
                                        nest: true,
                                        raw: true
                                    });

                                    if (dbCustomEvent[0]) {
                                        clientDefinedCustomEventId = dbCustomEvent[0].event_id
                                    }
                                }

                                const userUpdateWalletCollection = db.collection(collectionName);

                                let startDate = param.noOfRecords === 'all' ? null : dbTask[0].current_start_date ? new Date(dbTask[0].current_start_date) : null;
                                const dbTaskBus = await sequelize.query(`select * from task_bus where task_id=:taskId and user_id=:userId order by created_at desc limit 1;`, {
                                    type: QueryTypes.SELECT,
                                    replacements: {
                                        taskId: task.taskId,
                                        userId: userId
                                    }
                                });

                                if (dbTaskBus.length && dbTaskBus[0].created_at > startDate) {
                                    startDate = dbTaskBus[0].created_at;
                                }

                                const pipeline = getAggregateQuery({
                                    parameters: task.parameters,
                                    userId,
                                    limit: param.noOfRecords || null,
                                    startDate: startDate,
                                    endDate: dbTask[0].current_end_date ? new Date(dbTask[0].current_end_date) : null,
                                    businessLogic: task.businessLogic,
                                    customEventId: clientDefinedCustomEventId
                                });
                                const result = pipeline ? await userUpdateWalletCollection.aggregate(pipeline).toArray() : [];
                                if (result.length) {
                                    paramDetails[param.parameterName] = result[0][param.parameterName + "Sum"]
                                }
                            }
                        }
                    }

                    let ruleEngine = new Engine();
                    ruleEngine.addRule({
                        conditions: task.businessLogic,
                        name: 'test',
                        event: '',
                        onFailure: async () => {
                            paramDetails = originalParamDetails;
                            if (taskValidationInit) {
                                await utsc.insertOne({
                                    taskId: task.taskId,
                                    projectId: projectId,
                                    userId: userId,
                                    status: 'failed'
                                })
                            }
                        },
                        onSuccess: async () => {
                            paramDetails = originalParamDetails;
                            if (shouldEvaluate) {
                                const dbTask = await sequelize.query(`select * from tasks where id=:taskId`, {
                                    replacements: {
                                        taskId: task.taskId
                                    },
                                    raw: true,
                                    nest: true
                                });

                                if (dbTask.length && dbTask[0].is_available_for_current_cycle === true) {
                                    const dbTaskBus = await sequelize.query(`select * from task_bus where task_id=:taskId and user_id=:userId and created_at >=:currentStartDate and created_at<=:currentEndDate order by created_at desc limit 1;`, {
                                        replacements: {
                                            taskId: task.taskId,
                                            userId: userId,
                                            currentStartDate: dbTask[0].current_start_date,
                                            currentEndDate: dbTask[0].current_end_date ? dbTask[0].current_end_date : new Date().toISOString()
                                        },
                                        raw: true,
                                        nest: true
                                    });

                                    // if (isPassedTaskConfigValidationCriteria) {
                                    const taskStatus = dbTask[0].reward_claim === 'automatic' ? 'reward_claimed' : 'completed';
                                    await sequelize.query(`insert into task_bus(id, status, meta, project_id, user_id, task_id, task_group_id, active, archive, created_at, updated_at)
values (uuid_generate_v4(), '${taskStatus}', null, '${projectId}', '${userId}', '${task.taskId}', null, true, false, now(), now())`, {
                                        type: QueryTypes.INSERT,
                                        nest: true
                                    });

                                    await utsc.insertOne({
                                        taskId: task.taskId,
                                        projectId: projectId,
                                        userId: userId,
                                        status: 'succeed'
                                    });
                                    await axios.post('http://localhost:3000/v1/task/grantReward', {
                                        userId: userId,
                                        eventId: eventId,
                                        taskId: task.taskId
                                    });

                                    if (task.taskGroupId) {
                                        const dbTaskGroup = await sequelize.query(`select * from task_groups where id=:taskGroupId`, {
                                            replacements: {
                                                taskGroupId: task.taskGroupId
                                            },
                                            type: QueryTypes.SELECT,
                                            raw: true,
                                            nest: true
                                        });

                                        const dbTaskGroupBus = await sequelize.query(`select * from task_bus where task_group_id='${task.taskGroupId}' and user_id='${userId}' and created_at >=:currentStartDate and created_at<=:currentEndDate order by created_at desc limit 1;`, {
                                            type: QueryTypes.SELECT,
                                            replacements: {
                                                currentStartDate: dbTaskGroup[0].current_start_date,
                                                currentEndDate: dbTask[0].current_end_date ? dbTask[0].current_end_date : new Date().toISOString()
                                            },
                                            nest: true,
                                            raw: true
                                        });

                                        if (!dbTaskGroupBus.length) {
                                            const noOfConfigTasks = await sequelize.query(`select id from tasks where task_group_id=:taskGroupId and archive=:archive and is_available_for_current_cycle=:isAvailableForCurrentCycle;`, {
                                                type: QueryTypes.SELECT,
                                                replacements: {
                                                    taskGroupId: task.taskGroupId,
                                                    archive: false,
                                                    isAvailableForCurrentCycle: true
                                                },
                                                nest: true,
                                                raw: true
                                            });

                                            const ids = noOfConfigTasks.map(item => `'${item.id}'`).join(', ');

                                            const noOfTasksCompleted = await sequelize.query(`select count(*) from task_bus where task_id in (${ids}) and user_id='${userId}' and created_at >=:currentStartDate and created_at<=:currentEndDate;`,
                                                {
                                                    type: QueryTypes.SELECT,
                                                    replacements: {
                                                        currentStartDate: dbTaskGroup[0].current_start_date,
                                                        currentEndDate: dbTask[0].current_end_date ? dbTask[0].current_end_date : new Date().toISOString()
                                                    }
                                                });
                                            if (Number(noOfTasksCompleted[0].count) >= noOfConfigTasks.length) {
                                                const taskBusStatus = dbTaskGroup[0].reward_claim === 'automatic' ? 'reward_claimed' : 'completed';

                                                // Task group is completed
                                                await sequelize.query(`insert into task_bus(id, status, meta, project_id, user_id, task_id, task_group_id, active, archive, created_at, updated_at)
                     values (uuid_generate_v4(), '${taskBusStatus}', null, '${projectId}', '${userId}', null, '${task.taskGroupId}', true, false, now(), now())`, {
                                                    type: QueryTypes.INSERT,
                                                    nest: true
                                                });

                                                await axios.post('http://localhost:3000/v1/task/grantReward', {
                                                    userId: userId,
                                                    eventId: eventId,
                                                    taskGroupId: task.taskGroupId
                                                });
                                            }
                                        }
                                        // }
                                    }
                                }
                            }
                        }
                    });
                    await ruleEngine.run(paramDetails);
                    ruleEngine.stop();
                }
            } catch (err) {
                console.log('error', err);
            }
        }

        return res.json({success: true})
    } catch (err) {
        // console.log('error', err);
        // return res.status(500).json({error: err});
    } finally {
        // Close Mongoose connection
        console.log('closing mongodb connection')
        await client.close();

        console.log('closing sequelize connection')
        // Close Sequelize connection
        await sequelize.close();
    }


    function getAggregateQuery({parameters, userId, limit, startDate, endDate, businessLogic, customEventId}) {
        if (!limit || !Number(limit)) {
            function buildMatchExpression(condition) {
                let expressions = [];

                if (condition.all) {
                    expressions = expressions.concat(condition.all.map(clause => {
                        if (clause.all || clause.any) {
                            return buildMatchExpression(clause);
                        } else {
                            return clauseToMatch(clause);
                        }
                    }));
                }

                if (condition.any) {
                    expressions.push({
                        $or: condition.any.map(clause => {
                            if (clause.all || clause.any) {
                                return buildMatchExpression(clause);
                            } else {
                                return clauseToMatch(clause);
                            }
                        })
                    });
                }
                return expressions.length === 1 ? expressions[0] : {$and: expressions};
            }

            function clauseToMatch(clause) {
                const param = parameters.find(p => p.parameterName === clause.fact);
                let expression = {};

                if (param.incrementalType === "cumulative") {
                    expression = {
                        $or: [
                            { [`data.defaultParams.${clause.fact}`]: { $exists: true } },
                            { [`data.customParams.${clause.fact}`]: { $exists: true } }
                        ]
                    };
                } else {
                    expression = {
                        $or: [
                            {[`data.defaultParams.${clause.fact}`]: clause.value},
                            {[`data.customParams.${clause.fact}`]: clause.value}
                        ]
                    };
                }
                return expression;
            }

            let matchConditions = buildMatchExpression(businessLogic);
            matchConditions = Array.isArray(matchConditions) ? matchConditions : [matchConditions];

            let initialMatchStage;
            if (customEventId) {
                initialMatchStage = {
                    $match: {
                        userId: userId,
                        // Dynamically add 'createdAt' conditions based on the presence of 'startDate' and 'endDate'
                        ...(startDate || endDate ? {
                            createdAt: {
                                ...(startDate ? {$gte: startDate} : {}),
                                ...(endDate ? {$lte: endDate} : {})
                            }
                        } : {}),
                        $and: [
                            ...matchConditions, // Spread the match conditions array into the $and array
                            {'data.defaultParams.eventId': customEventId}
                        ]
                    },
                };
            }

            if (!customEventId) {
                initialMatchStage = {
                    $match: {
                        userId: userId,
                        // Dynamically add 'createdAt' conditions based on the presence of 'startDate' and 'endDate'
                        ...(startDate || endDate ? {
                            createdAt: {
                                ...(startDate ? {$gte: startDate} : {}),
                                ...(endDate ? {$lte: endDate} : {})
                            }
                        } : {}),
                        $and: matchConditions
                    },
                };
            }

            let groupStage = {
                $group: {
                    _id: null,
                    ...parameters.filter(p => p.incrementalType === 'cumulative').reduce((acc, param) => {
                        acc[param.parameterName + "Sum"] = {
                            $sum: {
                                $add: [
                                    {$ifNull: [`$data.defaultParams.${param.parameterName}`, 0]},
                                    {$ifNull: [`$data.customParams.${param.parameterName}`, 0]}
                                ]
                            }
                        };
                        return acc;
                    }, {})
                }
            };

            let projectStage = {
                $project: {
                    _id: 0,
                    ...parameters.filter(p => p.incrementalType === 'cumulative').reduce((acc, param) => {
                        acc[param.parameterName + "Sum"] = 1;
                        return acc;
                    }, {})
                }
            };

            let pipeline = [initialMatchStage, groupStage, projectStage];

            return pipeline;
        }

        if (limit && Number(limit)) {
            function buildMatchExpression(condition) {
                let expressions = [];

                if (condition.all) {
                    expressions = expressions.concat(condition.all.map(clause => {
                        if (clause.all || clause.any) {
                            return buildMatchExpression(clause);
                        } else {
                            return clauseToMatch(clause);
                        }
                    }));
                }

                if (condition.any) {
                    expressions.push({
                        $or: condition.any.map(clause => {
                            if (clause.all || clause.any) {
                                return buildMatchExpression(clause);
                            } else {
                                return clauseToMatch(clause);
                            }
                        })
                    });
                }

                return expressions.length === 1 ? expressions[0] : {$and: expressions};
            }

            function clauseToMatch(clause) {
                const param = parameters.find(p => p.parameterName === clause.fact);
                let expression = {};

                if (param.incrementalType === "cumulative") {
                    expression = {
                        $or: [
                            { [`data.defaultParams.${clause.fact}`]: { $exists: true } },
                            { [`data.customParams.${clause.fact}`]: { $exists: true } }
                        ]
                    };
                } else {
                    expression = {
                        $or: [
                            {[`data.defaultParams.${clause.fact}`]: clause.value},
                            {[`data.customParams.${clause.fact}`]: clause.value}
                        ]
                    };
                }
                return expression;
            }

            let matchConditions = buildMatchExpression(businessLogic);
            matchConditions = Array.isArray(matchConditions) ? matchConditions : [matchConditions];

            // let initialMatchStage = {$match: {userId: userId}};
            let initialMatchStage;
            if (customEventId) {
                initialMatchStage = {
                    $match: {
                        userId: userId,
                        // Dynamically add 'createdAt' conditions based on the presence of 'startDate' and 'endDate'
                        ...(startDate || endDate ? {
                            createdAt: {
                                ...(startDate ? {$gte: startDate} : {}),
                                ...(endDate ? {$lte: endDate} : {})
                            }
                        } : {}),
                        'data.defaultParams.eventId': customEventId,
                    },
                };
            }

            if (!customEventId) {
                initialMatchStage = {
                    $match: {
                        userId: userId,
                        // Dynamically add 'createdAt' conditions based on the presence of 'startDate' and 'endDate'
                        ...(startDate || endDate ? {
                            createdAt: {
                                ...(startDate ? {$gte: startDate} : {}),
                                ...(endDate ? {$lte: endDate} : {})
                            }
                        } : {})
                    },
                };
            }

// Sort stage by _id in descending order
            let sortStage = {$sort: {_id: -1}};

// Limit stage, adjust the number as per your requirement
            let limitStage = {$limit: limit};

            let groupStage = {
                $group: {
                    _id: null,
                    ...parameters.filter(p => p.incrementalType === 'cumulative').reduce((acc, param) => {
                        acc[param.parameterName + "Sum"] = {
                            $sum: {
                                $add: [
                                    {$ifNull: [`$data.defaultParams.${param.parameterName}`, 0]},
                                    {$ifNull: [`$data.customParams.${param.parameterName}`, 0]}
                                ]
                            }
                        };
                        return acc;
                    }, {})
                }
            };

            let projectStage = {
                $project: {
                    _id: 0,
                    ...parameters.filter(p => p.incrementalType === 'cumulative').reduce((acc, param) => {
                        acc[param.parameterName + "Sum"] = 1;
                        return acc;
                    }, {})
                }
            };

// Incorporate sort and limit stages before the group stage
            let pipeline = [initialMatchStage, sortStage, limitStage, groupStage, projectStage];

            return pipeline;
        }
    }
})

function parseUTCDateToLocal(utcDateString) {
    // const utcDate = new Date(utcDateString);
    // // Adjust to local time by subtracting the timezone offset
    // return new Date(utcDate.getTime() - utcDate.getTimezoneOffset() * 60000);
    return utcDateString;
}


function getTodayAtMidnight() {
    const now = new Date();
    return new Date(now.setHours(0, 0, 0, 0));

    // For testing purpose day is set to 3 min
    // return startOfDay;
}

function getLastSundayAtMidnight() {
    const now = new Date();
    // Get the current day of the week, 0 (Sunday) to 6 (Saturday)
    const today = now.getUTCDay();
    // Calculate the difference to last Sunday. If today is Sunday, use today's date.
    let diff = today === 0 ? 0 : -today;

    // Create a new Date object for last Sunday
    const lastSunday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));

    // Set the time to midnight (00:00:00)
    lastSunday.setUTCHours(0, 0, 0, 0);

    return lastSunday;
    // // For testing: "Last Sunday at Midnight" is considered as 4 minutes ago
    // console.log('startOfWeek', startOfWeek);
    // return startOfWeek;
}

function resetStartOfDay() {
    startOfDay = new Date(); // Reset to current time
    console.log('startOfDay has been reset to:', startOfDay);
}

function resetStartOfWeek() {
    startOfWeek = new Date(); // Reset to current time
    console.log('startOfWeek has been reset to:', startOfWeek);
}
