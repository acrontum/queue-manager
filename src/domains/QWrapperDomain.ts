import * as amqp from 'amqplib/callback_api';
import { Channel, Message as amqMessage, Options } from 'amqplib/callback_api';
import { ConsumerResponse, QWrapperSettings } from '../models';
import { inspect } from 'util';

const packageName = 'q-wrapper: ';

export class QWrapperDomain {

  private _verboseLogging: boolean = false;
  private _settings: QWrapperSettings;
  private _channel: amqp.Channel | undefined;
  private _connection: amqp.Connection | undefined;

  constructor (settings: QWrapperSettings) {
    this._settings = settings;
  }

  logVerbose (key: string, toLog?: any) {
    if (this._verboseLogging) {
      console.log(packageName + ' ' + key);
      if (toLog) {
        console.log(inspect(toLog, false, null, true /* enable colors */));
      }
    }
  }

  public initialize (settings?: QWrapperSettings): Promise<void> {
    if (settings) {
      this._settings = settings;
      this._verboseLogging = !!(this._settings.verboseLogging || process.env['q-wrapper:verbose-logging']);
    }

    return new Promise<void>((resolve) => {
      amqp.connect(this._settings.connection, (error0, connection) => {
        if (error0) {
          console.error(`${packageName} Error connecting to queue... `, error0);
          throw error0;
        }
        this._connection = connection;
        console.info(`${packageName} Connection established to message broker host`);

        this._connection.createChannel((error1, channel) => {
          if (error1) {
            console.error(`${packageName} Error creating channel... `, error1);
            throw error1;
          }
          this._channel = channel;
          console.info(`${packageName} Channel created successfully`);

          const durable = { durable: true };
          this._channel.assertExchange(this._settings.exchange, this._settings.exchangeType, durable);
          console.info(`${packageName} Exchange: '${this._settings.exchange}' asserted successfully`);

          this._channel.assertQueue(this._settings.dleQueue, durable);
          console.info(`${packageName} DLE Queue: '${this._settings.dleQueue}' asserted successfully`);

          this._channel.bindQueue(this._settings.dleQueue, this._settings.exchange, this._settings.dleQueue);

          this._channel.assertQueue(this._settings.queue, {
            durable: true,
            deadLetterExchange: this._settings.exchange,
            deadLetterRoutingKey: this._settings.dleQueue
          });
          console.info(`${packageName} Queue: '${this._settings.queue}' asserted successfully`);

          this._channel.bindQueue(this._settings.queue, this._settings.exchange, this._settings.queue);

          this._channel.prefetch(this._settings.prefetch || 1);

          if (this._settings.reconnect) {
            connection.on('close', () => {
              console.error('[AMQP] reconnecting');
              this.initialize(this._settings);
            });
          }

          return resolve();
        });
      });
    });
  }

  public sendToQueue (message: object, queueName?: string, msgOptions?: Options.Publish): boolean {
    if (this._channel) {
      this.logVerbose('sendToQueue called', { message, queueName: queueName || 'not defined' });

      const messageToSend = Buffer.from(JSON.stringify(message));
      const queue = queueName ? queueName : this._settings.queue;

      const response = this._channel.sendToQueue(queue, messageToSend, {
        persistent: true,
        contentType: 'application/json',
        ...(msgOptions || {}),
      });

      this.logVerbose('sendToQueue completed', { response });

      return response;
    } else {
      throw Error('Channel not set up.');
    }
  }

  public sendToExchange (message: object, routingKey?: string, msgOptions?: Options.Publish): boolean {
    if (this._channel) {
      this.logVerbose('sendToExchange called', { message, routingKey: routingKey || 'not defined' });

      const messageToSend = Buffer.from(JSON.stringify(message));
      routingKey = routingKey ? routingKey : this._settings.queue;

      const response = this._channel.publish(this._settings.exchange, routingKey, messageToSend, msgOptions);
      this.logVerbose('sendToExchange completed', { response });

      return response;
    } else {
      throw Error('Channel not set up.');
    }
  }

  public consume (callback: (message: amqMessage) => Promise<ConsumerResponse>, consumeDLE: boolean = false): void {
    if (this._channel) {
      const channel = this._channel;
      const queue = consumeDLE ? this._settings.dleQueue : this._settings.queue;
      channel.consume(queue, async (message) => {
        this.logVerbose('consume callback called', { message: message || 'not defined' });
        if (message) {
          const consumerResponse = await callback(message);
          this.logVerbose('consume callback completed:', consumerResponse);
          this.sendResponseToChannel(consumerResponse, channel, message);
          this.logVerbose('sendResponseToChannel completed');
        }
      }, {
        noAck: false
      });
    } else {
      throw Error(`${packageName} Channel not set up.`);
    }
  }

  public async consumeDLE (callback: (message: amqMessage) => Promise<ConsumerResponse>): Promise<void> {
    return this.consume(callback, true);
  }

  public close (): Promise<void> {
    return new Promise((resolve) => {
      if (!this._channel) {
        return resolve();
      }
      this._channel.close(() => {
        console.info(`${packageName} Channel closed`);
        this._channel = undefined;
        return resolve();
      });
    });
  }

  public closeConnection (): Promise<any> {
    return new Promise(async (resolve, reject) => {
      await this.close();

      if (!this._connection) {
        return resolve();
      }
      this._connection.close((err?: any) => {
        if (err) {
          return reject(err);
        }
        console.info(`${packageName} Connection closed`);
        this._connection = undefined;
        return resolve();
      });
    });
  }

  private sendResponseToChannel (consumerResponse: ConsumerResponse, channel: Channel, message: amqMessage) {
    this.logVerbose('sendResponseToChannel called');
    channel.ack(message);
    if (!consumerResponse.processed) {
      channel.sendToQueue(this._settings.dleQueue, message.content);
    }
  }
}
