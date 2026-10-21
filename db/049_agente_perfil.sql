-- Ponto de extensão pra bundles de ferramentas/gatilhos/posfiltro por conta
-- (lib/agente/executor.js hoje é hardcoded pra um negócio só — produção sob
-- encomenda/impressão 3D). Default explícito preserva 100% do comportamento
-- atual de toda conta existente (inclusive Basic 3D Print) sem precisar de
-- UPDATE de backfill manual.
alter table crm_agente_config
  add column perfil_agente text not null default 'basic3d_producao_sob_encomenda';
