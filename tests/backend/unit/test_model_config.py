"""Guards on the central OpenAI model registry.

OpenAI retires models on a few months' notice, and the previous ids were spread
across four modules. These tests exist so a retirement is caught here rather
than by production 404s, and so a well-meaning "upgrade to the flagship" cannot
quietly make the paid tiers margin-negative.
"""

import importlib
import logging
from datetime import UTC, date, datetime

import pytest

# Models with an announced shutdown date. A default must never point at one.
# Dates are OpenAI's published shutdowns as of 2026-07-25.
RETIRED_MODELS = {
    'gpt-5.2': date(2026, 8, 10),
    'o4-mini': date(2026, 10, 23),
    # The registry deliberately still uses this one until its shutdown, so the
    # guard below is date-aware rather than a flat ban — otherwise the only way
    # to express "in use, retiring later" is to omit it, which is what made an
    # earlier version of this test check nothing.
    'o4-mini-deep-research': date(2026, 10, 23),
}

# Per-1M-token output price, USD. The paid tiers are priced against these; a
# default costing materially more than the Pro grant can absorb is a pricing
# bug, not a model preference.
OUTPUT_PRICE_PER_1M = {
    'gpt-5.6-luna': 6.00,
    'gpt-5.6-terra': 15.00,
    'gpt-5.6-sol': 30.00,
    'gpt-5.5': 30.00,
    'gpt-5.4': 15.00,
    'gpt-5.4-mini': 4.50,
    'gpt-5.4-nano': 1.25,
}

GENERAL_PURPOSE_KEYS = ('MODEL_GENERAL', 'MODEL_ANALYSIS', 'DEFAULT_PLANNER_MODEL')


@pytest.fixture
def model_config():
    """Freshly reloaded registry, restored afterwards.

    The tests below reload the module under patched environments; without the
    teardown a later test could observe 'some-future-model' and the suite would
    become order-dependent.
    """
    import shared_services.model_config as mc

    yield importlib.reload(mc)
    importlib.reload(mc)


class TestNoRetiredDefaults:
    @pytest.mark.parametrize('key', [*GENERAL_PURPOSE_KEYS, 'MODEL_DEEP_RESEARCH'])
    def test_default_is_not_past_its_shutdown(self, model_config, key):
        """A default may be retiring, but must not already be retired.

        Fails the day a shutdown lands, which is the point: the build breaks
        before customers see 404s from OpenAI.
        """
        value = getattr(model_config, key)
        shutdown = RETIRED_MODELS.get(value)
        if shutdown is None:
            return
        today = datetime.now(UTC).date()
        assert shutdown > today, (
            f'{key} points at {value}, which OpenAI retired on {shutdown}. '
            f'Set the matching env var / default to a current model.'
        )

    def test_the_registry_knows_about_every_model_we_guard(self, model_config):
        """A shutdown date recorded here must also drive the runtime warning."""
        missing = set(RETIRED_MODELS) - set(model_config.MODEL_SHUTDOWNS)
        assert not missing, f'shutdown dates known to tests but not to model_config: {sorted(missing)}'


#: Ceiling on output price for the high-volume general-purpose models.
#:
#: Set at gpt-5.6-terra's 15.00 as a deliberate quality-for-margin trade. At
#: terra the 3,000-op Pro grant costs ~USD 37.50 against ~USD 76.41 of net
#: revenue, which is comfortable on ops alone but leaves only ~USD 38.91 for
#: deep research — and 25 credits at the top of their USD 0.50-2.00 range is
#: USD 50.00. A Pro subscriber who exhausts both buckets is therefore
#: loss-making; see the margin note in docs/CONFIGURATION.md.
#:
#: The ceiling exists to stop the *next* step up happening silently:
#: gpt-5.6-sol at 30.00 would put the ops grant alone at ~USD 75 of USD 76.41.
MAX_GENERAL_PURPOSE_OUTPUT_PRICE = 15.00


class TestCostCeiling:
    @pytest.mark.parametrize('key', GENERAL_PURPOSE_KEYS)
    def test_general_purpose_defaults_stay_affordable(self, model_config, key):
        """Guard the model tier the high-volume ops run on.

        Moving above this ceiling is a repricing decision — the Pro grant stops
        fitting inside Pro's revenue — so it must be made deliberately rather
        than by editing a model id.
        """
        value = getattr(model_config, key)
        price = OUTPUT_PRICE_PER_1M.get(value)
        assert price is not None, (
            f'{key}={value} has no entry in OUTPUT_PRICE_PER_1M. Add its output '
            f'price before adopting it — skipping here would silently disable the '
            f'margin guard for exactly the case it exists to catch: a new model.'
        )
        assert price <= MAX_GENERAL_PURPOSE_OUTPUT_PRICE, (
            f'{key}={value} costs USD {price}/1M output tokens, above the '
            f'{MAX_GENERAL_PURPOSE_OUTPUT_PRICE} ceiling. The 3,000-op Pro grant '
            f'stops fitting inside USD 79 of revenue — reprice the tiers '
            f'deliberately before raising this.'
        )


class TestEnvOverride:
    @pytest.mark.parametrize(
        ('env_var', 'key'),
        [
            ('OPENAI_MODEL_GENERAL', 'MODEL_GENERAL'),
            ('OPENAI_MODEL_ANALYSIS', 'MODEL_ANALYSIS'),
            ('OPENAI_MODEL_DEEP_RESEARCH', 'MODEL_DEEP_RESEARCH'),
            ('PLANNER_MODEL', 'DEFAULT_PLANNER_MODEL'),
        ],
    )
    def test_every_model_is_env_overridable(self, model_config, monkeypatch, env_var, key):
        """A forced retirement must be answerable by config, not a code deploy.

        Takes the fixture purely for its teardown, which reloads the module
        under the restored environment.
        """
        monkeypatch.setenv(env_var, 'some-future-model')
        assert getattr(importlib.reload(model_config), key) == 'some-future-model'


class TestCallSitesUseTheRegistry:
    def test_no_hardcoded_retired_ids_remain_in_backend(self):
        """A stray literal would survive a config-only migration and 404 in prod."""
        import pathlib
        import re

        root = pathlib.Path(__file__).resolve().parents[3] / 'backend' / 'lambdas'
        offenders = []
        for path in root.rglob('*.py'):
            # Two modules legitimately name retired ids: model_config, whose
            # MODEL_SHUTDOWNS map is the point, and llm_cost, whose price table
            # retains them so historical usage still prices correctly.
            if '.aws-sam' in path.parts or path.name in ('model_config.py', 'llm_cost.py'):
                continue
            for num, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
                code = line.split('#', 1)[0]
                for retired in RETIRED_MODELS:
                    if re.search(rf"""['"]{re.escape(retired)}['"]""", code):
                        offenders.append(f'{path.relative_to(root)}:{num}')
        assert not offenders, (
            f'retired model ids hardcoded outside the allowlisted registry/pricing '
            f'modules (model_config.py, llm_cost.py): {offenders}'
        )


class TestDeprecationNotices:
    """o4-mini-deep-research retires 2026-10-23; the warning is how we notice."""

    def test_silent_well_before_the_shutdown(self, model_config):
        assert model_config.deprecation_notice('o4-mini-deep-research', today=date(2026, 1, 1)) is None

    def test_warns_inside_the_window(self, model_config):
        notice = model_config.deprecation_notice('o4-mini-deep-research', today=date(2026, 9, 1))
        assert notice is not None
        assert '2026-10-23' in notice
        assert '52 days' in notice
        # The message must say what to do, not merely that something is wrong.
        assert 'OPENAI_MODEL_' in notice

    def test_escalates_after_the_shutdown(self, model_config):
        notice = model_config.deprecation_notice('o4-mini-deep-research', today=date(2026, 11, 1))
        assert notice is not None
        assert 'was retired' in notice
        assert 'expected to fail' in notice

    def test_current_models_are_never_flagged(self, model_config):
        assert model_config.deprecation_notice('gpt-5.6-terra') is None

    def test_warn_helper_logs_when_a_notice_applies(self, model_config, monkeypatch, caplog):
        # Stub the notice rather than relying on a real model still being inside
        # its window: the date arithmetic is covered above, and coupling this to
        # the calendar would make it fail on a future run for no real reason.
        monkeypatch.setattr(model_config, 'deprecation_notice', lambda _m: 'retiring soon')

        with caplog.at_level(logging.WARNING):
            model_config.warn_if_deprecated('any-model', context='unit test')

        assert any('retiring soon' in r.getMessage() for r in caplog.records)
        assert any('unit test' in r.getMessage() for r in caplog.records)

    def test_warn_helper_is_silent_when_no_notice_applies(self, model_config, monkeypatch, caplog):
        monkeypatch.setattr(model_config, 'deprecation_notice', lambda _m: None)

        with caplog.at_level(logging.WARNING):
            model_config.warn_if_deprecated('any-model')

        assert not caplog.records
