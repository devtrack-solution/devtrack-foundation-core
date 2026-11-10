import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'inbox_messages' })
export class InboxMessageOrmEntity {
  @PrimaryColumn({ name: 'consumer_id', type: 'varchar', length: 128 })
  consumerId!: string;

  @PrimaryColumn({ name: 'message_id', type: 'varchar', length: 128 })
  messageId!: string;

  @Column({
    name: 'received_at_ms',
    type: 'bigint',
    transformer: {
      to: (v: number) => v,
      from: (v: string | number) => Number(v),
    },
  })
  receivedAtMs!: number;
}
