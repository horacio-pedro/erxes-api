import * as amqplib from 'amqplib';
import * as dotenv from 'dotenv';
import { ActivityLogs, Conversations, Customers } from './db/models';
import { debugBase } from './debuggers';
import { graphqlPubsub } from './pubsub';
import { get, set } from './redisClient';

dotenv.config();

const { NODE_ENV, RABBITMQ_HOST = 'amqp://localhost' } = process.env;

interface IWidgetMessage {
  action: string;
  data: {
    trigger: string;
    type: string;
    payload: any;
  };
}

let connection;
let channel;

const receiveWidgetNotification = async ({ action, data }: IWidgetMessage) => {
  if (NODE_ENV === 'test') {
    return;
  }

  if (action === 'callPublish') {
    if (data.trigger === 'conversationMessageInserted') {
      const { customerId, conversationId } = data.payload;
      const conversation = await Conversations.findOne({ _id: conversationId }, { integrationId: 1 });
      const customerLastStatus = await get(`customer_last_status_${customerId}`);

      // if customer's last status is left then mark as joined when customer ask
      if (conversation && customerLastStatus === 'left') {
        set(`customer_last_status_${customerId}`, 'joined');

        // customer has joined + time
        const conversationMessages = await Conversations.changeCustomerStatus(
          'joined',
          customerId,
          conversation.integrationId,
        );

        for (const message of conversationMessages) {
          graphqlPubsub.publish('conversationMessageInserted', {
            conversationMessageInserted: message,
          });
        }

        // notify as connected
        graphqlPubsub.publish('customerConnectionChanged', {
          customerConnectionChanged: {
            _id: customerId,
            status: 'connected',
          },
        });
      }
    }

    graphqlPubsub.publish(data.trigger, { [data.trigger]: data.payload });
  }

  if (action === 'activityLog') {
    ActivityLogs.createLogFromWidget(data.type, data.payload);
  }
};

export const sendMessage = async (action: string, data?: any) => {
  if (channel) {
    await channel.assertQueue('erxes-api-notification');
    await channel.sendToQueue('erxes-api-notification', Buffer.from(JSON.stringify({ action, data: data || {} })));
  }
};

const initConsumer = async () => {
  // Consumer
  try {
    connection = await amqplib.connect(RABBITMQ_HOST);
    channel = await connection.createChannel();

    // listen for widgets api =========
    await channel.assertQueue('widgetNotification');

    channel.consume('widgetNotification', async msg => {
      if (msg !== null) {
        await receiveWidgetNotification(JSON.parse(msg.content.toString()));
        channel.ack(msg);
      }
    });

    // listen for engage api ===========
    await channel.assertQueue('engagesApi');

    channel.consume('engagesApi', async msg => {
      if (msg !== null) {
        const { action, data } = JSON.parse(msg.content.toString());

        if (action === 'setDoNotDisturb') {
          await Customers.updateOne({ _id: data.customerId }, { $set: { doNotDisturb: 'Yes' } });
        }

        channel.ack(msg);
      }
    });
  } catch (e) {
    debugBase(e.message);
  }
};

initConsumer();