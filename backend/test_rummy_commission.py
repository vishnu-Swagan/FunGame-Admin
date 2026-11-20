from unittest.mock import AsyncMock, patch
import asyncio
import pytest
import rummy_commission as fees


def test_fifteen_percent_examples_and_fractional_chip_rounding():
    assert fees.split_pot(100000,1500)['fee_chips']==15000
    assert fees.split_pot(100000,1500)['winner_payout_chips']==85000
    assert fees.split_pot(500,1500)['fee_chips']==75
    assert fees.split_pot(500,1500)['winner_payout_chips']==425
    assert fees.split_pot(505,1500)['fee_chips']==75
    assert fees.split_pot(505,1500)['winner_payout_chips']==430
    assert fees.split_pot(500,0)['winner_payout_chips']==500


@pytest.mark.parametrize('value',[-1,10000,True,15.0,'1500',None])
def test_invalid_rates_fail_closed(value):
    with pytest.raises(ValueError):fees.commission_bps(value)


def test_commission_configuration_is_frozen_and_legacy_rooms_stay_zero():
    import routes_rummy as rr
    category={'id':'LV1','maxPlayers':5,'entryChips':100,'houseCommissionBps':1500}
    snapshot=rr._freeze_category(category)
    category['houseCommissionBps']=2500
    assert rr._freeze_category(snapshot)['houseCommissionBps']==1500
    legacy={k:v for k,v in category.items() if k!='houseCommissionBps'}
    assert rr._freeze_category(legacy)['houseCommissionBps']==0
    async def scenario():
        with patch.object(rr,'_category',AsyncMock(return_value=category)):
            result=await rr._room_category({'category_id':'LV1'})
            assert result['houseCommissionBps']==0
    asyncio.run(scenario())
