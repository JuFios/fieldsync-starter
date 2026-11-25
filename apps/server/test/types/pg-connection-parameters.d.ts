// pg's internal resolver of connection settings (connection string, explicit options, PG* variables).
declare module 'pg/lib/connection-parameters' {
  export default class ConnectionParameters {
    constructor(config: object);
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly database: string;
  }
}
