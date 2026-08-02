export type PraxisPhaseBudget = "observation"|"grounding"|"revalidation"|"dispatch"|"localVerification"|"effectVerification";
const shares: Record<PraxisPhaseBudget, number> = { observation:.18, grounding:.32, revalidation:.08, dispatch:.16, localVerification:.10, effectVerification:.16 };

export class PraxisBudget {
  readonly startedAt = performance.now();
  constructor(readonly totalMs: number) {}
  remaining() { return Math.max(0, this.totalMs - (performance.now() - this.startedAt)); }
  forPhase(phase: PraxisPhaseBudget) { return Math.max(0, Math.min(this.remaining(), this.totalMs * shares[phase])); }
  exhausted() { return this.remaining() <= 0; }
}

export type PraxisEscalationLevel = 0|1|2|3|4|5;
export function escalationLevel(input:{historyCompatible:boolean;semanticAuthoritative:boolean;behaviorRequired:boolean;visualUsed:boolean;adapterUsed:boolean;budgetExhausted:boolean}):PraxisEscalationLevel {
  if (input.budgetExhausted) return 5;
  if (input.adapterUsed) return 4;
  if (input.visualUsed) return 3;
  if (input.behaviorRequired) return 2;
  if (input.historyCompatible && input.semanticAuthoritative) return 0;
  return 1;
}

export type PraxisMetric = { name:string;value:number;dimensions:Record<string,string> };
export class PraxisMetrics {
  constructor(private readonly sink:(metric:PraxisMetric)=>void=()=>undefined){}
  timing(phase:string,durationMs:number,dimensions:Record<string,string>={}){this.sink({name:"praxis.phase.duration_ms",value:durationMs,dimensions:{phase,...dimensions}});}
  escalation(level:PraxisEscalationLevel,dimensions:Record<string,string>={}){this.sink({name:"praxis.escalation",value:level,dimensions});}
}
