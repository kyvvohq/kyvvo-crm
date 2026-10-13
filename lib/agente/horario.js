// Horário de atendimento por conta (crm_agente_config.horario_atendimento):
// {"inicio":"08:00","fim":"18:00","fuso":"America/Sao_Paulo","dias":null|[1..7]}
// dias usa ISO (1 = segunda ... 7 = domingo); null = todos os dias.

const DIA_ISO = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function minutos(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return h * 60 + (m || 0);
}

function dentroDoHorario(horario, data = new Date()) {
  const h = horario || {};
  const fuso = h.fuso || 'America/Sao_Paulo';
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(data);
  const get = (t) => partes.find((p) => p.type === t).value;
  const dia = DIA_ISO[get('weekday')];
  const agora = Number(get('hour')) * 60 + Number(get('minute'));
  if (Array.isArray(h.dias) && !h.dias.includes(dia)) return false;
  return agora >= minutos(h.inicio || '08:00') && agora < minutos(h.fim || '18:00');
}

module.exports = { dentroDoHorario };
