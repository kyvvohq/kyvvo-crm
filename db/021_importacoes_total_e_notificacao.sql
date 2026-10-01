-- Importação de NF-e passa a processar em segundo plano (vários arquivos
-- grandes travavam a requisição síncrona, sem dar nenhum feedback de
-- progresso) — `total_arquivos` guarda o denominador fixo pra tela mostrar
-- "X de Y processados" fazendo polling em GET /crm/api/importacoes/:id, sem
-- precisar recontar nada a cada chamada.
alter table crm_importacoes add column total_arquivos int;
