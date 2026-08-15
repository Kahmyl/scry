import type {
  AssuranceDescriptor,
  MaybePromise,
} from "../core/types.js";

export interface FixtureSession<TValue, TTruth> {
  value: TValue;

  /**
   * Out-of-band authoritative fixture state.
   *
   * This should not simply repeat whatever the subsystem
   * under test claims happened.
   */
  readGroundTruth(): MaybePromise<TTruth>;
}

export interface FixtureDefinition<
  TValue,
  TTruth,
  TContext = undefined,
> extends AssuranceDescriptor {
  setup(
    context: TContext,
  ): MaybePromise<FixtureSession<TValue, TTruth>>;

  teardown?(
    session: FixtureSession<TValue, TTruth>,
    context: TContext,
  ): MaybePromise<void>;
}

export function defineFixture<
  TValue,
  TTruth,
  TContext = undefined,
>(
  definition: FixtureDefinition<
    TValue,
    TTruth,
    TContext
  >,
): FixtureDefinition<TValue, TTruth, TContext> {
  return definition;
}

export async function withFixture<
  TValue,
  TTruth,
  TContext,
  TResult,
>(
  fixture: FixtureDefinition<
    TValue,
    TTruth,
    TContext
  >,
  context: TContext,
  use: (
    session: FixtureSession<TValue, TTruth>,
  ) => MaybePromise<TResult>,
): Promise<TResult> {
  const session = await fixture.setup(context);

  try {
    return await use(session);
  } finally {
    await fixture.teardown?.(
      session,
      context,
    );
  }
}
