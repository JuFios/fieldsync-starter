import { describeWithDb, useIntegration } from '../support/integration';

describeWithDb('integration harness', () => {
  const ctx = useIntegration();

  it('serves the app from its own database on an ephemeral port', async () => {
    const health = await ctx.api.get<{ status: string }>('/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    const { rows } = await ctx.db.query<{ db: string }>('SELECT current_database() AS db');
    expect(rows[0].db).toBe(ctx.database.name);
  });

  it('creates users whose tokens the server accepts', async () => {
    const site = await ctx.fixtures.site();
    const tech = await ctx.fixtures.technician(site);
    const me = await ctx.api.get<{ id: string; sites: Array<{ id: string }> }>('/me', tech.token);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(tech.id);
    expect(me.body.sites.map((s) => s.id)).toEqual([site]);
  });
});
