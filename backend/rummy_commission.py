"""Whole-chip, prospective Rummy house commission arithmetic."""
POLICY_VERSION = 'rummy-pot-commission-v1'


def commission_bps(value=0):
    if type(value) is not int or not 0 <= value < 10000:
        raise ValueError('Rummy commission must be integer basis points from 0 to 9999')
    return value


def split_pot(gross_pot, basis_points):
    if type(gross_pot) is not int or gross_pot < 0:
        raise ValueError('Rummy pot must be a nonnegative whole-chip amount')
    bps = commission_bps(basis_points)
    # Fractional chips stay with the winner, never rounded into the house fee.
    fee = gross_pot * bps // 10000
    return {'gross_pot_chips': gross_pot, 'fee_bps': bps,
            'fee_chips': fee, 'winner_payout_chips': gross_pot - fee,
            'policy_version': POLICY_VERSION, 'rounding': 'FLOOR_WHOLE_CHIPS'}
