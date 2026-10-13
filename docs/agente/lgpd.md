# Agente de atendimento — dados pessoais e LGPD

A Kyvvo é **operadora**; a Basic (a conta) é a **controladora**. Este documento descreve o que o agente faz com dados pessoais para a conta decidir prazos e responder a titulares.

## O que vai ao modelo (Anthropic)
- Histórico recente da conversa (até 30 mensagens), com **CPF e CNPJ digitados pela cliente mascarados** (`[CPF removido]`).
- Primeiro nome da cliente (ou o nome do perfil do WhatsApp).
- Briefing já coletado do pedido (produto, medida, nomes a gravar, cidade/CEP informados).
- **Nunca vão:** telefone, e-mail, endereço completo, CPF/CNPJ cadastrados, valores financeiros, anexos (imagens/STL — o modelo só sabe que um arquivo chegou).
- A chave da API é da Kyvvo; o fornecedor da IA é suboperador. Confirmar o contrato/DPA vigente antes do uso em produção.

## O que o agente nunca pede
CPF. A identidade da cliente é o telefone (E.164), como no resto do CRM.

## Onde ficam os dados
| Dado | Tabela | Retenção |
|---|---|---|
| Mensagens e status | `crm_mensagens_whatsapp` | Segue o cadastro da cliente (registro do relacionamento) |
| Anexos (arquivos) | `crm_anexos` + disco `uploads/agente/<tenant>/` | Segue o pedido/cadastro |
| Execuções do agente (texto proposto, texto original bloqueado, ferramentas e entradas, tokens) | `crm_agente_execucoes` | **`crm_agente_config.retencao_logs_dias`** — expurgo automático a cada 6 h; `null` = não apaga (padrão até a conta definir) |
| Encaminhamentos | `crm_handoffs` | Segue o cadastro |
| Eventos (`agente_*`, `atendimento_*`) | `crm_eventos` | Imutáveis; seguem o cadastro |

Prazo sugerido para a Basic definir: 90 dias para execuções (suficiente para auditar e ajustar o prompt). Ação: `update crm_agente_config set retencao_logs_dias = 90 where tenant_id = '<TENANT>';`.

## Direitos do titular
A exclusão de um cliente remove seus eventos, mas pedidos vinculados a ele impedem a exclusão (`crm_pedidos.cliente_id` é `restrict`), e mensagens e anexos da conversa são guardados por telefone, fora dessa cascata. **Ainda não há rotina de anonimização/exclusão do titular que cubra mensagens, anexos e conversas do agente** — pendência (ver pendencias.md).

## Isolamento
Todas as tabelas têm `tenant_id` e toda consulta filtra por ele; o tenant das ferramentas do agente vem do servidor, nunca do modelo. Anexos têm chave com prefixo do tenant e só são servidos ao próprio tenant.
